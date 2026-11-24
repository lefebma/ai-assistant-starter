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
import { REVOKE_PATH } from './relay.js'
import { RENEW_BEFORE_MS, readEntries, saveEntry, dropEntry, renewEntries, relayPost, relayKey, type KeeperResult, type RelayClient, type RelayEntry } from './relay-entries.js'
import type { ConnectTokenVault, Revoker } from './box.js'
import { registerRotatingSecret } from '../log-redact.js'

export const GMAIL_ENTRY = 'CONNECT_GMAIL'
/** The live access tokens, {account: token}, for the gog wrapper. */
export const RELAY_TOKENS_ENV = 'GOG_RELAY_TOKENS'
export { RENEW_BEFORE_MS, relayPost }
export type { RelayClient }
export const KEEPER_TICK_MS = 5 * 60_000

export type { KeeperResult }

export type GmailEntry = RelayEntry

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

const key = relayKey

/**
 * Every relay-connected Gmail account, keyed by lower-cased address. Reads the
 * #206 single-account shape too, so a box connected before #271 keeps working
 * and is rewritten in the new shape on its next change.
 */
export function readGmailEntries(vault: ConnectTokenVault): Map<string, GmailEntry> {
  return readEntries(vault, GMAIL_ENTRY)
}

/** Add an account, or replace it when the same address signs in again. */
export function saveGmailEntry(vault: ConnectTokenVault, e: GmailEntry): void {
  saveEntry(vault, GMAIL_ENTRY, e)
}

/**
 * Delete one account. With refreshToken, only if the entry still holds it: a
 * new sign-in for the same address while a removal waited on the relay wins.
 * False if nothing was deleted.
 */
export function dropGmailEntry(vault: ConnectTokenVault, account: string, refreshToken?: string): boolean {
  return dropEntry(vault, GMAIL_ENTRY, account, refreshToken)
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
    // The logger only read the environment at start-up: tell it each token as
    // it goes in, so a log line holding one is scrubbed (card #269).
    for (const e of live) {
      registerRotatingSecret(`gmail:${e.account}:access`, e.accessToken)
      registerRotatingSecret(`gmail:${e.account}:refresh`, e.refreshToken)
    }
    if (live.length) this.env[RELAY_TOKENS_ENV] = JSON.stringify(Object.fromEntries(live.map((e) => [e.account, e.accessToken])))
    else delete this.env[RELAY_TOKENS_ENV]
    if (!this.o.shim && live.length === 1) this.env.GOG_ACCESS_TOKEN = live[0].accessToken
    else delete this.env.GOG_ACCESS_TOKEN
    activeAccounts = live.map((e) => e.account)
  }

  private async run(): Promise<KeeperResult> {
    const { result, withdrawn } = await renewEntries({
      vault: this.o.vault,
      name: GMAIL_ENTRY,
      provider: 'gmail',
      client: { ...this.o, fetchImpl: this.doFetch, now: this.now },
      now: this.now,
      // A grant withdrawn mid-loop leaves the environment at once.
      onWithdrawn: () => this.publish(),
    })
    // Publish before telling anyone: a withdrawn token leaves the environment
    // now, not after a chat message that may be slow to send.
    this.publish()
    for (const a of withdrawn) await this.o.onRevoked?.(a)
    return result
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
