/**
 * Keeps fresh Gmail access tokens for the Gmail accounts connected through the
 * sign-in relay, one per account (card #271; #206 allowed only one).
 *
 * A refresh token from the relay's Google Web client can only be renewed with
 * that client's secret, which lives on the relay and never on a box. So the
 * box sends each refresh token to the relay's /refresh, signed with its
 * hand-off key, and keeps the access token it gets back.
 *
 * gog takes one access token (GOG_ACCESS_TOKEN) and then uses it whatever
 * --account a call names. So the live tokens go into GOG_RELAY_TOKENS, keyed by
 * account, and the gog wrapper (gog-shim.ts) sets GOG_ACCESS_TOKEN for the
 * account each call names. Accounts gog signed in itself keep using its own
 * stored tokens. Where the wrapper cannot be installed (Windows), a box with a
 * single relay account falls back to the #206 behaviour: that token in
 * GOG_ACCESS_TOKEN for every call.
 *
 * The refresh tokens the box holds are sealed by the relay to this box, so they
 * are useless anywhere else; what the environment carries are access tokens
 * that last an hour. Anything that can run gog could already reach the mail, so
 * the agent seeing them is no wider than gog's own keyring.
 *
 * Renewal starts once less than RENEW_BEFORE_MS is left, which leaves a turn
 * that started on the old token enough time to finish on it.
 *
 * When the relay says a grant is gone (revoked at Google, password change),
 * that account's token is dropped, its entry is kept so /connect list still
 * shows it, and the owner is told once to run /connect gmail again. The other
 * accounts carry on.
 */
import { signHandoff, REFRESH_PATH, REVOKE_PATH, SIGNATURE_HEADER } from './relay.js'
import type { ConnectTokenVault, Revoker } from './box.js'

export const GMAIL_ENTRY = 'CONNECT_GMAIL'
/** The live access tokens, {account: token}, for the gog wrapper. */
export const RELAY_TOKENS_ENV = 'GOG_RELAY_TOKENS'
export const RENEW_BEFORE_MS = 30 * 60_000
export const KEEPER_TICK_MS = 5 * 60_000

export type KeeperResult = 'none' | 'fresh' | 'renewed' | 'expired' | 'failed'

export interface GmailEntry {
  account: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** Set once the relay reported the grant revoked. */
  revoked?: boolean
}

export interface KeeperOpts {
  relayUrl: string
  boxId: string
  handoffKey: string
  vault: ConnectTokenVault
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  /** Told once per revoked grant. */
  onRevoked?: (account: string) => void | Promise<void>
  /**
   * True when gog calls go through the wrapper. Without it a single relay
   * account also goes into GOG_ACCESS_TOKEN, as in #206.
   */
  shim?: boolean
}

let activeAccounts: string[] = []

export interface RelayClient {
  relayUrl: string
  boxId: string
  handoffKey: string
  fetchImpl?: typeof fetch
  now?: () => number
}

/** A POST to the relay, signed with this box's hand-off key. Throws only if the relay cannot be reached. */
export async function relayPost(c: RelayClient, path: string, fields: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = JSON.stringify({ box: c.boxId, ...fields, ts: (c.now ?? Date.now)() })
  const res = await (c.fetchImpl ?? fetch)(new URL(path, c.relayUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signHandoff(c.handoffKey, body) },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Gmail revocation goes through the relay: only it can open the sealed refresh token. */
export function relayRevoker(c: RelayClient, provider = 'gmail'): Revoker {
  return async ({ refreshToken }) => {
    const r = await relayPost(c, REVOKE_PATH, { provider, refreshToken })
    if (r.status !== 200) throw new Error(`revoke ${r.status}`)
  }
}

/**
 * The relay-connected Gmail accounts whose tokens are live, for the places
 * that otherwise find Gmail accounts through `gog auth list` (which only knows
 * gog's own stored sign-ins).
 */
export function relayGmailAccounts(): string[] {
  return [...activeAccounts]
}

const key = (account: string) => account.trim().toLowerCase()

function valid(e: Partial<GmailEntry> | null | undefined): e is GmailEntry {
  return !!e && typeof e.account === 'string' && typeof e.accessToken === 'string' && typeof e.refreshToken === 'string' && typeof e.expiresAt === 'number'
}

/**
 * Every relay-connected Gmail account, keyed by lower-cased address. Reads the
 * #206 single-account shape too, so a box connected before #271 keeps working
 * and is rewritten in the new shape on its next change.
 */
export function readGmailEntries(vault: ConnectTokenVault): Map<string, GmailEntry> {
  const out = new Map<string, GmailEntry>()
  const raw = vault.get(GMAIL_ENTRY)
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  const p = parsed as { accounts?: Record<string, Partial<GmailEntry>> } & Partial<GmailEntry>
  const list = p.accounts && typeof p.accounts === 'object' ? Object.values(p.accounts) : [p]
  for (const e of list) if (valid(e)) out.set(key(e.account), e)
  return out
}

function writeGmailEntries(vault: ConnectTokenVault, entries: Map<string, GmailEntry>): void {
  if (!entries.size) {
    vault.delete(GMAIL_ENTRY)
    return
  }
  vault.set(GMAIL_ENTRY, JSON.stringify({ accounts: Object.fromEntries(entries) }))
}

/** Add an account, or replace it when the same address signs in again. */
export function saveGmailEntry(vault: ConnectTokenVault, e: GmailEntry): void {
  const all = readGmailEntries(vault)
  all.set(key(e.account), { account: e.account, accessToken: e.accessToken, refreshToken: e.refreshToken, expiresAt: e.expiresAt })
  writeGmailEntries(vault, all)
}

/** Delete one account. False if it was not connected. */
export function dropGmailEntry(vault: ConnectTokenVault, account: string): boolean {
  const all = readGmailEntries(vault)
  if (!all.delete(key(account))) return false
  writeGmailEntries(vault, all)
  return true
}

const RANK: Record<KeeperResult, number> = { none: 0, fresh: 1, expired: 2, renewed: 3, failed: 4 }

export class GmailTokenKeeper {
  private readonly env: Record<string, string | undefined>
  private readonly now: () => number
  private readonly doFetch: typeof fetch
  private running: Promise<KeeperResult> | null = null

  constructor(private readonly o: KeeperOpts) {
    this.env = o.env ?? process.env
    this.now = o.now ?? Date.now
    this.doFetch = o.fetchImpl ?? fetch
  }

  /**
   * One check of every account. Overlapping calls share the run in flight.
   * The result is the most notable of the accounts' results: a failure first
   * (so it gets logged), then a renewal, then a revoked grant.
   */
  tick(): Promise<KeeperResult> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  private publish(): void {
    const now = this.now()
    const live = [...readGmailEntries(this.o.vault).values()].filter((e) => !e.revoked && e.expiresAt > now)
    if (live.length) this.env[RELAY_TOKENS_ENV] = JSON.stringify(Object.fromEntries(live.map((e) => [e.account, e.accessToken])))
    else delete this.env[RELAY_TOKENS_ENV]
    if (!this.o.shim && live.length === 1) this.env.GOG_ACCESS_TOKEN = live[0].accessToken
    else delete this.env.GOG_ACCESS_TOKEN
    activeAccounts = live.map((e) => e.account)
  }

  private async run(): Promise<KeeperResult> {
    let result: KeeperResult = 'none'
    for (const e of readGmailEntries(this.o.vault).values()) {
      const r = await this.renew(e)
      if (RANK[r] > RANK[result]) result = r
    }
    this.publish()
    return result
  }

  private async renew(e: GmailEntry): Promise<KeeperResult> {
    if (e.revoked) return 'expired'
    if (e.expiresAt - this.now() > RENEW_BEFORE_MS) return 'fresh'
    let res: { status: number; json: Record<string, unknown> }
    try {
      res = await relayPost({ ...this.o, fetchImpl: this.doFetch, now: this.now }, REFRESH_PATH, { provider: 'gmail', refreshToken: e.refreshToken })
    } catch {
      // Relay unreachable: keep using the current token while it lasts.
      return 'failed'
    }
    // Re-read after the round trip: a /connect remove or a new sign-in for
    // this account during it wins over this renewal.
    const all = readGmailEntries(this.o.vault)
    const current = all.get(key(e.account))
    if (current?.refreshToken !== e.refreshToken) return current ? 'fresh' : 'none'
    const j = res.json
    if (res.status === 401 && j.error === 'invalid_grant') {
      all.set(key(e.account), { ...current, revoked: true })
      writeGmailEntries(this.o.vault, all)
      await this.o.onRevoked?.(e.account)
      return 'expired'
    }
    if (res.status !== 200 || typeof j.accessToken !== 'string' || typeof j.expiresAt !== 'number') return 'failed'
    all.set(key(e.account), {
      account: e.account,
      accessToken: j.accessToken,
      refreshToken: typeof j.refreshToken === 'string' ? j.refreshToken : e.refreshToken,
      expiresAt: j.expiresAt,
    })
    writeGmailEntries(this.o.vault, all)
    return 'renewed'
  }
}

/**
 * The Google accounts gog will actually reach: its own stored sign-ins plus
 * the live relay-connected accounts, once each.
 */
export function withRelayGmail(accounts: string[]): string[] {
  const out = [...accounts]
  for (const a of activeAccounts) if (!out.some((x) => key(x) === key(a))) out.push(a)
  return out
}

/** Test seam: what the keeper sets when tokens go live or are dropped. */
export function setRelayGmailForTests(accounts: string[]): void {
  activeAccounts = [...accounts]
}

export function resetRelayGmailForTests(): void {
  activeAccounts = []
}
