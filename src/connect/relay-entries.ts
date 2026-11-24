/**
 * What the Gmail and Drive keepers share: the relay-connected accounts stored
 * in the vault under one entry name, and their renewal through the relay's
 * /refresh. Nothing here touches the environment; publishing live tokens is
 * the caller's business (Gmail does, Drive deliberately never does).
 */
import { signHandoff, REFRESH_PATH, SIGNATURE_HEADER } from './relay.js'
import type { ConnectTokenVault } from './box.js'

export const RENEW_BEFORE_MS = 30 * 60_000

export type KeeperResult = 'none' | 'fresh' | 'renewed' | 'expired' | 'failed'

export interface RelayEntry {
  account: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** Set once the relay reported the grant revoked. */
  revoked?: boolean
}

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

export const relayKey = (account: string) => account.trim().toLowerCase()

function valid(e: Partial<RelayEntry> | null | undefined): e is RelayEntry {
  return !!e && typeof e.account === 'string' && typeof e.accessToken === 'string' && typeof e.refreshToken === 'string' && typeof e.expiresAt === 'number'
}

/**
 * Every account stored under `name`, keyed by lower-cased address. Also reads
 * the #206 single-account shape, so a box connected before #271 keeps working
 * and is rewritten in the new shape on its next change.
 */
export function readEntries(vault: ConnectTokenVault, name: string): Map<string, RelayEntry> {
  const out = new Map<string, RelayEntry>()
  const raw = vault.get(name)
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  const p = parsed as { accounts?: Record<string, Partial<RelayEntry>> } & Partial<RelayEntry>
  const list = p.accounts && typeof p.accounts === 'object' ? Object.values(p.accounts) : [p]
  for (const e of list) if (valid(e)) out.set(relayKey(e.account), e)
  return out
}

export function writeEntries(vault: ConnectTokenVault, name: string, entries: Map<string, RelayEntry>): void {
  if (!entries.size) {
    vault.delete(name)
    return
  }
  vault.set(name, JSON.stringify({ accounts: Object.fromEntries(entries) }))
}

/** Add an account, or replace it when the same address signs in again. */
export function saveEntry(vault: ConnectTokenVault, name: string, e: RelayEntry): void {
  const all = readEntries(vault, name)
  all.set(relayKey(e.account), { account: e.account, accessToken: e.accessToken, refreshToken: e.refreshToken, expiresAt: e.expiresAt })
  writeEntries(vault, name, all)
}

/**
 * Delete one account. With refreshToken, only if the entry still holds it: a
 * new sign-in for the same address while a removal waited on the relay wins.
 * False if nothing was deleted.
 */
export function dropEntry(vault: ConnectTokenVault, name: string, account: string, refreshToken?: string): boolean {
  const all = readEntries(vault, name)
  const e = all.get(relayKey(account))
  if (!e || (refreshToken !== undefined && e.refreshToken !== refreshToken)) return false
  all.delete(relayKey(account))
  writeEntries(vault, name, all)
  return true
}

const RANK: Record<KeeperResult, number> = { none: 0, fresh: 1, expired: 2, renewed: 3, failed: 4 }

export interface RenewOpts {
  vault: ConnectTokenVault
  name: string
  provider: string
  client: RelayClient
  now: () => number
  /** Called right after a grant is marked revoked, before the next account is checked. */
  onWithdrawn?: () => void
}

/**
 * One check of every account under `name`: renew the ones with less than
 * RENEW_BEFORE_MS left through the relay. The result is the most notable of
 * the accounts' results (a failure first, then a renewal, then a revoked
 * grant); `withdrawn` lists accounts newly found revoked.
 */
export async function renewEntries(o: RenewOpts): Promise<{ result: KeeperResult; withdrawn: string[] }> {
  let result: KeeperResult = 'none'
  const withdrawn: string[] = []
  for (const e of readEntries(o.vault, o.name).values()) {
    const r = await renewOne(o, e, withdrawn)
    if (RANK[r] > RANK[result]) result = r
  }
  return { result, withdrawn }
}

async function renewOne(o: RenewOpts, e: RelayEntry, withdrawn: string[]): Promise<KeeperResult> {
  if (e.revoked) return 'expired'
  if (e.expiresAt - o.now() > RENEW_BEFORE_MS) return 'fresh'
  let res: { status: number; json: Record<string, unknown> }
  try {
    res = await relayPost(o.client, REFRESH_PATH, { provider: o.provider, refreshToken: e.refreshToken })
  } catch {
    // Relay unreachable: keep using the current token while it lasts.
    return 'failed'
  }
  // Re-read after the round trip: a /connect remove or a new sign-in for
  // this account during it wins over this renewal.
  const all = readEntries(o.vault, o.name)
  const current = all.get(relayKey(e.account))
  if (current?.refreshToken !== e.refreshToken) return current ? 'fresh' : 'none'
  const j = res.json
  if (res.status === 401 && j.error === 'invalid_grant') {
    all.set(relayKey(e.account), { ...current, revoked: true })
    writeEntries(o.vault, o.name, all)
    o.onWithdrawn?.()
    withdrawn.push(e.account)
    return 'expired'
  }
  if (res.status !== 200 || typeof j.accessToken !== 'string' || typeof j.expiresAt !== 'number') return 'failed'
  all.set(relayKey(e.account), {
    account: e.account,
    accessToken: j.accessToken,
    refreshToken: typeof j.refreshToken === 'string' ? j.refreshToken : e.refreshToken,
    expiresAt: j.expiresAt,
  })
  writeEntries(o.vault, o.name, all)
  return 'renewed'
}
