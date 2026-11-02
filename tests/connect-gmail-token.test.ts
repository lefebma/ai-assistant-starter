/**
 * Card #206: Gmail renewal through the relay. The keeper runs against a fake
 * relay that is the real createRelay with a fake Google provider, so the
 * signature, the skew check and the error codes are the production ones.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GmailTokenKeeper, GMAIL_ENTRY, RENEW_BEFORE_MS, relayGmailAccount, resetRelayGmailForTests, setRelayGmailForTests, withRelayGmail } from '../src/connect/gmail-token.js'
import { createRelay, GrantRevokedError, seal, unseal, signHandoff, type RelayProvider } from '../src/connect/relay.js'
import { MemoryUsedStore } from '../src/connect/state.js'
import type { ConnectTokenVault } from '../src/connect/box.js'
import { discoverCalendars } from '../src/proactive/calendar.js'

const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'
const SECRET = 'relay-signing-secret-for-tests-0123456789'
const SEAL = 'relay-sealing-secret-for-tests-0123456789'
const HOUR = 3_600_000

afterEach(() => resetRelayGmailForTests())

function memVault(): ConnectTokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n) }
}

function setup(opts: { refresh?: RelayProvider['refresh']; relayDown?: boolean; handoffKey?: string } = {}) {
  let t = 10 * HOUR
  const vault = memVault()
  const env: Record<string, string | undefined> = {}
  const refreshed: string[] = []
  const logs: unknown[] = []
  const revoked: string[] = []
  const relay = createRelay({
    publicUrl: 'https://connect.gethavn.ai',
    signingSecret: SECRET,
    sealingSecret: SEAL,
    boxes: { get: (id) => (id === 'box-1' ? { origin: 'https://box1.example.com', handoffKey: HKEY } : undefined) },
    providers: {
      gmail: {
        label: 'Google',
        authOrigin: 'https://fake-idp.test',
        authUrl: () => 'https://fake-idp.test/',
        exchange: async () => { throw new Error('unused') },
        refresh: opts.refresh ?? (async (rt) => {
          refreshed.push(rt)
          return { accessToken: `AT-${refreshed.length}`, expiresAt: t + HOUR }
        }),
      },
    },
    used: new MemoryUsedStore(),
    now: () => t,
    log: (e) => logs.push(e),
  })
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (opts.relayDown) throw new Error('ECONNREFUSED')
    return relay.handle(new Request(url, init))
  }) as unknown as typeof fetch
  const keeper = new GmailTokenKeeper({
    relayUrl: 'https://connect.gethavn.ai', boxId: 'box-1', handoffKey: opts.handoffKey ?? HKEY,
    vault, env, fetchImpl, now: () => t, onRevoked: (a) => void revoked.push(a),
  })
  // What a hand-off leaves on the box: the refresh token sealed to box-1.
  const connect = async (expiresIn: number, rt = 'RT-1') =>
    vault.set(GMAIL_ENTRY, JSON.stringify({ account: 'me@gmail.com', accessToken: 'AT-0', refreshToken: await seal(SEAL, 'box-1', 'gmail', rt), expiresAt: t + expiresIn }))
  const entry = () => JSON.parse(vault.data.get(GMAIL_ENTRY)!) as Record<string, unknown>
  const heldToken = async () => unseal(SEAL, 'box-1', 'gmail', entry().refreshToken as string)
  return { keeper, vault, env, refreshed, logs, revoked, connect, entry, heldToken, advance: (ms: number) => (t += ms) }
}

describe('GmailTokenKeeper', () => {
  it('does nothing and clears the token when Gmail is not connected', async () => {
    const s = setup()
    s.env.GOG_ACCESS_TOKEN = 'left over'
    expect(await s.keeper.tick()).toBe('none')
    expect(s.env.GOG_ACCESS_TOKEN).toBeUndefined()
    expect(relayGmailAccount()).toBeUndefined()
  })

  it('puts a token with time left straight into the environment, without asking the relay', async () => {
    const s = setup()
    await s.connect(HOUR)
    expect(await s.keeper.tick()).toBe('fresh')
    expect(s.env.GOG_ACCESS_TOKEN).toBe('AT-0')
    expect(relayGmailAccount()).toBe('me@gmail.com')
    expect(s.refreshed).toEqual([])
  })

  it('renews through the relay once under half an hour is left, keeping the refresh token', async () => {
    const s = setup()
    await s.connect(HOUR)
    s.advance(HOUR - RENEW_BEFORE_MS + 1)
    expect(await s.keeper.tick()).toBe('renewed')
    expect(s.refreshed).toEqual(['RT-1'])
    expect(s.env.GOG_ACCESS_TOKEN).toBe('AT-1')
    expect(s.entry()).toMatchObject({ accessToken: 'AT-1' })
    expect(await s.heldToken()).toBe('RT-1')
    expect(JSON.stringify(s.logs)).not.toContain('RT-1')
    expect(JSON.stringify(s.logs)).not.toContain('AT-1')
  })

  it('stores a rotated refresh token', async () => {
    const s = setup({ refresh: async () => ({ accessToken: 'NEW', expiresAt: 99 * HOUR, refreshToken: 'RT-2' }) })
    await s.connect(0)
    await s.keeper.tick()
    expect(s.entry()).toMatchObject({ accessToken: 'NEW' })
    expect(await s.heldToken()).toBe('RT-2')
  })

  it('keeps the current token while the relay is unreachable, and drops it once expired', async () => {
    const s = setup({ relayDown: true })
    await s.connect(10 * 60_000)
    expect(await s.keeper.tick()).toBe('failed')
    expect(s.env.GOG_ACCESS_TOKEN).toBe('AT-0')
    s.advance(10 * 60_000 + 1)
    expect(await s.keeper.tick()).toBe('failed')
    expect(s.env.GOG_ACCESS_TOKEN).toBeUndefined()
  })

  it('on a revoked grant: drops the token, keeps the entry, tells the owner once, stops asking', async () => {
    const s = setup({ refresh: async (rt) => { s.refreshed.push(rt); throw new GrantRevokedError() } })
    await s.connect(0)
    expect(await s.keeper.tick()).toBe('expired')
    expect(s.env.GOG_ACCESS_TOKEN).toBeUndefined()
    expect(relayGmailAccount()).toBeUndefined()
    expect(s.entry()).toMatchObject({ account: 'me@gmail.com', revoked: true })
    expect(s.revoked).toEqual(['me@gmail.com'])
    expect(await s.keeper.tick()).toBe('expired')
    expect(s.revoked).toHaveLength(1)
    expect(s.refreshed).toHaveLength(1)
  })

  it('treats a provider outage as a failure, not a revocation', async () => {
    const s = setup({ refresh: async () => { throw new Error('token endpoint 503') } })
    await s.connect(0)
    expect(await s.keeper.tick()).toBe('failed')
    expect(s.revoked).toEqual([])
    expect(s.entry().revoked).toBeUndefined()
  })

  it('is refused by the relay when signed with the wrong key', async () => {
    const s = setup({ handoffKey: 'a-different-key-that-is-long-enough-000000' })
    await s.connect(0)
    expect(await s.keeper.tick()).toBe('failed')
    expect(s.refreshed).toEqual([])
  })

  it('lets overlapping ticks share one renewal', async () => {
    const s = setup()
    await s.connect(0)
    const [a, b] = await Promise.all([s.keeper.tick(), s.keeper.tick()])
    expect([a, b]).toEqual(['renewed', 'renewed'])
    expect(s.refreshed).toHaveLength(1)
  })

  it('does not bring back an entry removed during the renewal', async () => {
    let s!: ReturnType<typeof setup>
    s = setup({ refresh: async () => { s.vault.delete(GMAIL_ENTRY); return { accessToken: 'LATE', expiresAt: 99 * HOUR } } })
    await s.connect(0)
    expect(await s.keeper.tick()).toBe('none')
    expect(s.vault.data.has(GMAIL_ENTRY)).toBe(false)
    expect(s.env.GOG_ACCESS_TOKEN).toBeUndefined()
  })
})

describe('relay /refresh', () => {
  it('refuses a stale request, an unknown box and a provider without renewal', async () => {
    const relay = createRelay({
      publicUrl: 'https://connect.gethavn.ai',
      signingSecret: SECRET,
      boxes: { get: (id) => (id === 'box-1' ? { origin: 'https://b', handoffKey: HKEY } : undefined) },
      providers: { outlook: { authUrl: () => '', exchange: async () => { throw new Error() } } },
      used: new MemoryUsedStore(),
      now: () => 1_000_000_000,
    })
    const post = (b: Record<string, unknown>, key = HKEY) => {
      const raw = JSON.stringify(b)
      return relay.handle(new Request('https://connect.gethavn.ai/refresh', { method: 'POST', body: raw, headers: { 'x-connect-signature': signHandoff(key, raw) } }))
    }
    expect((await post({ box: 'box-1', provider: 'outlook', refreshToken: 'r', ts: 1_000_000_000 - 6 * 60_000 })).status).toBe(401)
    expect((await post({ box: 'nope', provider: 'outlook', refreshToken: 'r', ts: 1_000_000_000 })).status).toBe(401)
    expect((await post({ box: 'box-1', provider: 'outlook', refreshToken: 'r', ts: 1_000_000_000 })).status).toBe(400)
    expect((await post({ box: 'box-1', provider: 'outlook' })).status).toBe(400)
    const r = await relay.handle(new Request('https://connect.gethavn.ai/refresh', { method: 'POST', body: 'x'.repeat(20_000) }))
    expect(r.status).toBe(413)
  })
})

describe('relay-connected account in discovery', () => {
  it('is the only Google account while its token is live, since gog uses it for every call', () => {
    expect(withRelayGmail(['a@x.com'])).toEqual(['a@x.com'])
    setRelayGmailForTests('me@gmail.com')
    expect(withRelayGmail(['a@x.com', 'b@x.com'])).toEqual(['me@gmail.com'])
  })

  it('shows up as a Google calendar even though gog has no stored sign-in for it', async () => {
    setRelayGmailForTests('me@gmail.com')
    const exec = async () => ({ ok: true, stdout: 'old@x.com\tdefault\tcalendar,gmail\t2026' })
    const sources = await discoverCalendars({ exec, msAccounts: () => [] })
    expect(sources.map((s) => [s.id, s.provider])).toEqual([['me@gmail.com', 'google']])
  })
})
