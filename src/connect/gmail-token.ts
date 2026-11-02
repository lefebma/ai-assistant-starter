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
 * Renewal starts once less than RENEW_BEFORE_MS is left, which leaves a turn
 * that started on the old token enough time to finish on it.
 *
 * When the relay says the grant is gone (revoked at Google, password change),
 * the token is dropped from the environment, the entry is kept so /connect
 * list still shows what was connected, and the owner is told once to run
 * /connect gmail again.
 */
import { signHandoff, REFRESH_PATH, SIGNATURE_HEADER } from './relay.js'
import type { ConnectTokenVault } from './box.js'

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
    const body = JSON.stringify({ box: this.o.boxId, provider: 'gmail', refreshToken: e.refreshToken, ts: this.now() })
    let res: Response
    try {
      res = await this.doFetch(new URL(REFRESH_PATH, this.o.relayUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signHandoff(this.o.handoffKey, body) },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      // Relay unreachable: keep using the current token while it lasts.
      this.set(e)
      return 'failed'
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 401 && j.error === 'invalid_grant') {
      this.o.vault.set(GMAIL_ENTRY, JSON.stringify({ ...e, revoked: true }))
      this.set(null)
      await this.o.onRevoked?.(e.account)
      return 'expired'
    }
    if (!res.ok || typeof j.accessToken !== 'string' || typeof j.expiresAt !== 'number') {
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

/** `accounts` plus the relay-connected Gmail account, when its token is live and it is not already listed. */
export function withRelayGmail(accounts: string[]): string[] {
  const a = activeAccount
  return a && !accounts.some((x) => x.toLowerCase() === a.toLowerCase()) ? [...accounts, a] : accounts
}

/** Test seam: what the keeper sets when a token goes live or is dropped. */
export function setRelayGmailForTests(account: string | undefined): void {
  activeAccount = account
}

export function resetRelayGmailForTests(): void {
  activeAccount = undefined
}
