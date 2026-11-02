/**
 * Keeps a fresh Gmail access token in GOG_ACCESS_TOKEN for a Gmail account
 * connected through the sign-in relay.
 *
 * A refresh token from the relay's Google Web client can only be renewed with
 * that client's secret, which lives on the relay and never on a box. So the
 * box sends its refresh token to the relay's /refresh, signed with its
 * hand-off key, and puts the access token it gets back into the service's
 * environment. Every gog call inherits that environment (the agent's Bash
 * runs, the email alerts, the proactive calendar scan), and gog uses
 * GOG_ACCESS_TOKEN in place of its own stored sign-ins, so no call site needs
 * to know where the token came from.
 *
 * The refresh token the box holds is sealed by the relay to this box, so it is
 * useless anywhere else; what the environment carries is an access token that
 * lasts an hour. Anything that can run gog could already reach the mail, so
 * the agent seeing an hour-long token is no wider than gog's own keyring.
 *
 * Renewal starts once less than RENEW_BEFORE_MS is left, which leaves a turn
 * that started on the old token enough time to finish on it.
 *
 * When the relay says the grant is gone (revoked at Google, password change),
 * the token is dropped from the environment, the entry is kept so /connect
 * list still shows what was connected, and the owner is told once to run
 * /connect gmail again.
 */
import { signHandoff, REFRESH_PATH, REVOKE_PATH, SIGNATURE_HEADER } from './relay.js'
import type { ConnectTokenVault, Revoker } from './box.js'

export const GMAIL_ENTRY = 'CONNECT_GMAIL'
export const RENEW_BEFORE_MS = 30 * 60_000
export const KEEPER_TICK_MS = 5 * 60_000

export type KeeperResult = 'none' | 'fresh' | 'renewed' | 'expired' | 'failed'

interface Entry {
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
}

let activeAccount: string | undefined

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
 * The relay-connected Gmail account while its token is live, for the places
 * that otherwise find Gmail accounts through `gog auth list` (which only knows
 * gog's own stored sign-ins).
 */
export function relayGmailAccount(): string | undefined {
  return activeAccount
}

function read(vault: ConnectTokenVault): Entry | null {
  const raw = vault.get(GMAIL_ENTRY)
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as Partial<Entry>
    if (typeof e.account !== 'string' || typeof e.accessToken !== 'string' || typeof e.refreshToken !== 'string' || typeof e.expiresAt !== 'number') return null
    return e as Entry
  } catch {
    return null
  }
}

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

  /** One check. Overlapping calls share the run in flight. */
  tick(): Promise<KeeperResult> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  private set(e: Entry | null): void {
    if (e && !e.revoked && e.expiresAt > this.now()) {
      this.env.GOG_ACCESS_TOKEN = e.accessToken
      activeAccount = e.account
    } else {
      delete this.env.GOG_ACCESS_TOKEN
      activeAccount = undefined
    }
  }

  private async run(): Promise<KeeperResult> {
    const e = read(this.o.vault)
    if (!e) {
      this.set(null)
      return 'none'
    }
    if (e.revoked) {
      this.set(null)
      return 'expired'
    }
    if (e.expiresAt - this.now() > RENEW_BEFORE_MS) {
      this.set(e)
      return 'fresh'
    }
    let res: { status: number; json: Record<string, unknown> }
    try {
      res = await relayPost({ ...this.o, fetchImpl: this.doFetch, now: this.now }, REFRESH_PATH, { provider: 'gmail', refreshToken: e.refreshToken })
    } catch {
      // Relay unreachable: keep using the current token while it lasts.
      this.set(e)
      return 'failed'
    }
    const j = res.json
    if (res.status === 401 && j.error === 'invalid_grant') {
      this.o.vault.set(GMAIL_ENTRY, JSON.stringify({ ...e, revoked: true }))
      this.set(null)
      await this.o.onRevoked?.(e.account)
      return 'expired'
    }
    if (res.status !== 200 || typeof j.accessToken !== 'string' || typeof j.expiresAt !== 'number') {
      this.set(e)
      return 'failed'
    }
    const next: Entry = {
      account: e.account,
      accessToken: j.accessToken,
      refreshToken: typeof j.refreshToken === 'string' ? j.refreshToken : e.refreshToken,
      expiresAt: j.expiresAt,
    }
    // Re-read before writing: a /connect remove or a new sign-in during the
    // round trip wins over this renewal.
    if (read(this.o.vault)?.refreshToken !== e.refreshToken) return this.run()
    this.o.vault.set(GMAIL_ENTRY, JSON.stringify(next))
    this.set(next)
    return 'renewed'
  }
}

/**
 * The Google accounts gog will actually reach. While a relay-connected token
 * is live, gog uses it whatever --account a call names, so that account is the
 * only one: listing gog's older stored accounts as well would file the
 * connected account's mail and events under their names.
 */
export function withRelayGmail(accounts: string[]): string[] {
  return activeAccount ? [activeAccount] : accounts
}

/** Test seam: what the keeper sets when a token goes live or is dropped. */
export function setRelayGmailForTests(account: string | undefined): void {
  activeAccount = account
}

export function resetRelayGmailForTests(): void {
  activeAccount = undefined
}
