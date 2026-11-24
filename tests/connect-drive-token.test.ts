/**
 * Card #284: Drive token store and keeper. Renewal runs against the real
 * createRelay with a fake Google provider registered as "drive". Drive tokens
 * never go into the environment.
 */
import { describe, expect, it, vi } from 'vitest'
import { DriveTokenKeeper, DRIVE_ENTRY, readDriveEntries, saveDriveEntry, dropDriveEntry } from '../src/connect/drive-token.js'
import { readGmailEntries } from '../src/connect/gmail-token.js'
import { createRelay, seal, type RelayProvider } from '../src/connect/relay.js'
import { MemoryUsedStore } from '../src/connect/state.js'
import type { ConnectTokenVault } from '../src/connect/box.js'
import { createScrubber, clearRotatingSecrets, REDACTED } from '../src/log-redact.js'

const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'
const SECRET = 'relay-signing-secret-for-tests-0123456789'
const SEAL = 'relay-sealing-secret-for-tests-0123456789'
const HOUR = 3_600_000
const MIN = 60_000

function memVault(): ConnectTokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n), has: (n: string) => data.has(n) } as ConnectTokenVault & { data: Map<string, string> }
}

function setup(opts: { refresh?: RelayProvider['refresh'] } = {}) {
  const t = 10 * HOUR
  const vault = memVault()
  const onRevoked = vi.fn()
  const providers: string[] = []
  const bodies: string[] = []
  const refresh: RelayProvider['refresh'] = opts.refresh ?? (async () => ({ accessToken: 'NEW', expiresAt: t + HOUR }))
  const relay = createRelay({
    publicUrl: 'https://connect.gethavn.ai',
    signingSecret: SECRET,
    sealingSecret: SEAL,
    boxes: { get: (id) => (id === 'box-1' ? { origin: 'https://box1.example.com', handoffKey: HKEY } : undefined) },
    providers: {
      drive: {
        label: 'Google Drive',
        authOrigin: 'https://fake-idp.test',
        authUrl: () => 'https://fake-idp.test/',
        exchange: async () => { throw new Error('unused') },
        refresh: async (rt, ...rest) => { providers.push('drive'); return refresh(rt, ...rest) },
      },
    },
    used: new MemoryUsedStore(),
    now: () => t,
    log: () => {},
  })
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/refresh')) bodies.push(String(init.body))
    return relay.handle(new Request(url, init))
  }) as unknown as typeof fetch
  const keeper = new DriveTokenKeeper({ relayUrl: 'https://connect.gethavn.ai', boxId: 'box-1', handoffKey: HKEY, vault, fetchImpl, now: () => t, onRevoked })
  const connect = async (expiresIn: number, account = 'm@x.com') =>
    saveDriveEntry(vault, { account, accessToken: 'OLD', refreshToken: await seal(SEAL, 'box-1', 'drive', 'RT-1'), expiresAt: t + expiresIn })
  return { keeper, vault, onRevoked, bodies, providers, connect }
}

describe('DriveTokenKeeper', () => {
  it('renews through the relay as provider "drive"', async () => {
    const s = setup()
    await s.connect(MIN)
    expect(await s.keeper.tick()).toBe('renewed')
    expect(JSON.parse(s.bodies[0]).provider).toBe('drive')
    expect(s.providers).toEqual(['drive'])
    expect(readDriveEntries(s.vault).get('m@x.com')!.accessToken).toBe('NEW')
  })

  it('never puts a Drive token in the environment', async () => {
    const s = setup()
    await s.connect(MIN)
    await s.keeper.tick()
    expect(JSON.stringify(process.env)).not.toContain('NEW')
    expect(JSON.stringify(process.env)).not.toContain('OLD')
    expect(process.env.GOG_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.GOG_RELAY_TOKENS ?? '').not.toContain('m@x.com')
  })

  it('leaves a token with plenty of time alone', async () => {
    const s = setup()
    await s.connect(2 * HOUR)
    expect(await s.keeper.tick()).toBe('fresh')
    expect(s.bodies).toEqual([])
  })

  it('marks a withdrawn grant, tells the owner once, and reports reconnect', async () => {
    const { GrantRevokedError } = await import('../src/connect/relay.js')
    const s = setup({ refresh: async () => { throw new GrantRevokedError() } })
    await s.connect(MIN)
    expect(await s.keeper.tick()).toBe('expired')
    expect(await s.keeper.tick()).toBe('expired')
    expect(s.onRevoked).toHaveBeenCalledTimes(1)
    expect(s.keeper.accounts()).toEqual([{ account: 'm@x.com', state: 'reconnect' }])
    expect(await s.keeper.token('m@x.com')).toBeNull()
  })

  it('accounts() reports ok for a live account', async () => {
    const s = setup()
    await s.connect(2 * HOUR)
    expect(s.keeper.accounts()).toEqual([{ account: 'm@x.com', state: 'ok' }])
  })

  it('token() renews an almost-expired token before returning it', async () => {
    const s = setup()
    await s.connect(2 * MIN)
    expect(await s.keeper.token('m@x.com')).toBe('NEW')
  })

  it('token() returns a token with time left without asking the relay', async () => {
    const s = setup()
    await s.connect(2 * HOUR)
    expect(await s.keeper.token('M@X.com')).toBe('OLD')
    expect(s.bodies).toEqual([])
  })

  it('token() is null when renewal fails and the token is nearly out', async () => {
    const s = setup({ refresh: async () => { throw new Error('boom') } })
    await s.connect(2 * MIN)
    expect(await s.keeper.token('m@x.com')).toBeNull()
  })

  it('token() is null for an account that is not connected', async () => {
    const s = setup()
    expect(await s.keeper.token('nobody@x.com')).toBeNull()
  })

  it('keeps Drive and Gmail entries apart', () => {
    const s = setup()
    saveDriveEntry(s.vault, { account: 'm@x.com', accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    expect(readGmailEntries(s.vault).size).toBe(0)
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(false)
    expect(s.vault.data.has(DRIVE_ENTRY)).toBe(true)
  })

  it('token() registers what it returns with the log redactor, even before any tick', async () => {
    clearRotatingSecrets()
    const s = setup()
    saveDriveEntry(s.vault, { account: 'm@x.com', accessToken: 'drive-access-7f3a91', refreshToken: 'drive-refresh-2b8c44', expiresAt: 10 * HOUR + 2 * HOUR })
    expect(await s.keeper.token('m@x.com')).toBe('drive-access-7f3a91')
    const scrub = createScrubber()
    expect(scrub.string('call failed with drive-access-7f3a91 and drive-refresh-2b8c44')).toBe(`call failed with ${REDACTED} and ${REDACTED}`)
    clearRotatingSecrets()
  })

  it('dropDriveEntry honours the refresh token guard', () => {
    const s = setup()
    saveDriveEntry(s.vault, { account: 'm@x.com', accessToken: 'a', refreshToken: 'r', expiresAt: 1 })
    expect(dropDriveEntry(s.vault, 'm@x.com', 'other')).toBe(false)
    expect(dropDriveEntry(s.vault, 'm@x.com', 'r')).toBe(true)
    expect(s.vault.data.has(DRIVE_ENTRY)).toBe(false)
  })
})
