/**
 * Keeps fresh Google Drive access tokens for the Drive accounts connected
 * through the sign-in relay (card #284). Same store and renewal as Gmail
 * (relay-entries.ts), with provider "drive" and its own vault entry.
 *
 * Unlike Gmail, nothing here ever goes into the environment: no
 * GOG_ACCESS_TOKEN, no GOG_RELAY_TOKENS. The only way to a Drive token is
 * token(account), called by the Drive routes, which hand it to one gog call.
 * The Drive scope is read-only, but the agent has no business holding it.
 */
import type { ConnectTokenVault } from './box.js'
import { registerRotatingSecret } from '../log-redact.js'
import {
  dropEntry,
  readEntries,
  relayKey,
  renewEntries,
  saveEntry,
  type KeeperResult,
  type RelayClient,
  type RelayEntry,
} from './relay-entries.js'

export const DRIVE_ENTRY = 'CONNECT_DRIVE'
const MIN_LEFT_MS = 5 * 60_000

export type DriveEntry = RelayEntry

export const readDriveEntries = (vault: ConnectTokenVault) => readEntries(vault, DRIVE_ENTRY)
export const saveDriveEntry = (vault: ConnectTokenVault, e: DriveEntry) => saveEntry(vault, DRIVE_ENTRY, e)
export const dropDriveEntry = (vault: ConnectTokenVault, account: string, refreshToken?: string) => dropEntry(vault, DRIVE_ENTRY, account, refreshToken)

export interface DriveKeeperOpts {
  relayUrl: string
  boxId: string
  handoffKey: string
  vault: ConnectTokenVault
  fetchImpl?: typeof fetch
  now?: () => number
  /** Told once per revoked grant. */
  onRevoked?: (account: string) => void | Promise<void>
}

export class DriveTokenKeeper {
  private readonly now: () => number
  private readonly client: RelayClient
  private running: Promise<KeeperResult> | null = null

  constructor(private readonly o: DriveKeeperOpts) {
    this.now = o.now ?? Date.now
    this.client = { relayUrl: o.relayUrl, boxId: o.boxId, handoffKey: o.handoffKey, fetchImpl: o.fetchImpl, now: this.now }
  }

  /** One check of every account. Overlapping calls share the run in flight. */
  tick(): Promise<KeeperResult> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  /** Every connected Drive account and whether it needs signing in again. */
  accounts(): { account: string; state: 'ok' | 'reconnect' }[] {
    return [...readDriveEntries(this.o.vault).values()].map((e) => ({ account: e.account, state: e.revoked ? 'reconnect' : 'ok' }))
  }

  /**
   * A usable access token for the account, renewed first when under five
   * minutes are left. Null for an unknown or revoked account, or one that
   * cannot be renewed.
   */
  async token(account: string): Promise<string | null> {
    const k = relayKey(account)
    let e = readDriveEntries(this.o.vault).get(k)
    if (!e || e.revoked) return null
    if (e.expiresAt - this.now() < MIN_LEFT_MS) {
      // tick() renews anything under RENEW_BEFORE_MS, which covers this.
      await this.tick()
      e = readDriveEntries(this.o.vault).get(k)
      if (!e || e.revoked || e.expiresAt - this.now() < MIN_LEFT_MS) return null
    }
    // The log redactor only knows tokens a tick has seen. After a boot this one
    // may have come straight from the vault, so register it before it leaves.
    registerRotatingSecret(`drive:${e.account}:access`, e.accessToken)
    registerRotatingSecret(`drive:${e.account}:refresh`, e.refreshToken)
    return e.accessToken
  }

  private async run(): Promise<KeeperResult> {
    const { result, withdrawn } = await renewEntries({ vault: this.o.vault, name: DRIVE_ENTRY, provider: 'drive', client: this.client, now: this.now })
    // The logger only reads the environment at start-up: tell it each token so
    // a log line holding one is scrubbed. Registered, never published.
    for (const e of readDriveEntries(this.o.vault).values()) {
      if (e.revoked) continue
      registerRotatingSecret(`drive:${e.account}:access`, e.accessToken)
      registerRotatingSecret(`drive:${e.account}:refresh`, e.refreshToken)
    }
    for (const a of withdrawn) await this.o.onRevoked?.(a)
    return result
  }
}
