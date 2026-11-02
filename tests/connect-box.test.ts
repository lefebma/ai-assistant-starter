import { describe, it, expect } from 'vitest'
import { ConnectFlow, type ConnectTokenVault, type MsTokenStore, type Revoker } from '../src/connect/box.js'
import { signHandoff } from '../src/connect/relay.js'

const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'

function memVault(): ConnectTokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n) }
}

function memMs(): MsTokenStore & { data: Map<string, { accessToken: string; refreshToken: string; expiresAt: number }> } {
  // Slugs labels the way src/ms/store.ts does, so lookups by address and by label agree.
  const slug = (a: string) => a.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const data = new Map<string, { accessToken: string; refreshToken: string; expiresAt: number }>()
  return {
    data,
    save: (a, t) => void data.set(slug(a), t),
    load: (a) => data.get(slug(a)) ?? null,
    clear: (a) => data.delete(slug(a)),
    list: () => [...data.keys()],
  }
}

function setup(revoker?: Revoker) {
  let t = 5_000_000
  const changes: string[] = []
  const vault = memVault()
  const ms = memMs()
  const revoked: string[] = []
  const flow = new ConnectFlow({
    relayUrl: 'https://connect.gethavn.ai',
    boxId: 'box-1',
    handoffKey: HKEY,
    vault,
    msTokens: ms,
    onChange: (p) => void changes.push(p),
    now: () => t,
    revokers: { gmail: revoker ?? (async (tok) => void revoked.push(tok.refreshToken)) },
  })
  const nonceOf = (reply: string) => new URL(reply.match(/https:\/\/\S+/)![0]).searchParams.get('nonce')!
  const body = (nonce: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ nonce, provider: 'gmail', ts: t, account: 'x@y.com', accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, ...over })
  const send = (raw: string, sig = signHandoff(HKEY, raw)) => flow.acceptHandoff(raw, sig)
  return { flow, vault, ms, changes, revoked, nonceOf, body, send, advance: (d: number) => (t += d) }
}

describe('/connect start', () => {
  it('issues a one-time link naming this box and the provider', () => {
    const s = setup()
    const { reply } = s.flow.handleCommand('chat1', '/connect gmail')
    const u = new URL(reply.match(/https:\/\/\S+/)![0])
    expect(u.origin + u.pathname).toBe('https://connect.gethavn.ai/start')
    expect(u.searchParams.get('provider')).toBe('gmail')
    expect(u.searchParams.get('box')).toBe('box-1')
    expect(u.searchParams.get('nonce')!.length).toBeGreaterThanOrEqual(32)
  })
  it('sends yahoo to the /secret flow instead', () => {
    const s = setup()
    expect(s.flow.handleCommand('c', '/connect yahoo').reply).toContain('/secret set')
  })
  it('lists usage for unknown providers', () => {
    expect(setup().flow.handleCommand('c', '/connect nope').reply).toContain('/connect gmail')
  })
})

describe('hand-off acceptance', () => {
  it('stores tokens and confirms to the chat that asked', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect gmail').reply)
    const r = await s.send(s.body(nonce))
    expect(r).toMatchObject({ status: 200, chatId: 'chat1' })
    expect(r.message).toBe('Connected x@y.com, mail and calendar working.')
    expect(JSON.parse(s.vault.data.get('CONNECT_GMAIL')!)).toMatchObject({ account: 'x@y.com', refreshToken: 'RT' })
    expect(r.message).not.toContain('RT')
  })
  it('tells the keeper after a connect and after a removal, never after a refusal', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    await s.send(s.body(nonce))
    await s.send(s.body(nonce))
    expect(s.changes).toEqual(['gmail'])
    await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.changes).toEqual(['gmail', 'gmail'])
  })
  it('accepts a state only once', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce))).status).toBe(200)
    s.vault.data.clear()
    expect((await s.send(s.body(nonce))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses a state this box never issued', async () => {
    const s = setup()
    expect((await s.send(s.body('x'.repeat(32)))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses an expired pending state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    s.advance(10 * 60_000 + 1)
    expect((await s.send(s.body(nonce, { ts: 5_000_000 + 10 * 60_000 + 1 }))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses a bad or missing signature without spending the pending state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce), 'deadbeef')).status).toBe(401)
    expect((await s.send(s.body(nonce), '')).status).toBe(401)
    expect((await s.send(s.body(nonce))).status).toBe(200)
  })
  it('refuses a provider mismatch and spends the state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce, { provider: 'outlook' }))).status).toBe(403)
    expect((await s.send(s.body(nonce))).status).toBe(403)
  })
  it('refuses a stale timestamp and malformed bodies', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce, { ts: 1 }))).status).toBe(403)
    expect((await s.send('not json')).status).toBe(400)
    const missing = JSON.stringify({ nonce, provider: 'gmail', ts: 5_000_000 })
    expect((await s.send(missing)).status).toBe(400)
  })
})

describe('Outlook hand-off', () => {
  it('lands in the Microsoft token store, in seconds, where the Outlook tools read it', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect outlook').reply)
    const r = await s.send(s.body(nonce, { provider: 'outlook', account: 'me@contoso.com', expiresAt: 7_200_500 }))
    expect(r.status).toBe(200)
    expect(s.ms.data.get('ME_CONTOSO_COM')).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 7200 })
    expect(s.vault.data.has('CONNECT_OUTLOOK')).toBe(false)
    expect(s.flow.handleCommand('c', '/connect list').reply).toBe('outlook: ME_CONTOSO_COM')
  })
  it('removes one mailbox by address, and says where to withdraw access at Microsoft', async () => {
    const s = setup()
    for (const account of ['a@x.com', 'b@x.com']) {
      const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect outlook').reply)
      await s.send(s.body(nonce, { provider: 'outlook', account, refreshToken: `RT-${account}` }))
    }
    expect((await s.flow.handleCommandAsync('c', '/connect remove outlook')).reply).toContain('Which mailbox?')
    const r = await s.flow.handleCommandAsync('c', '/connect remove outlook b@x.com')
    expect(r.reply).toContain('account.live.com/consent/Manage')
    expect(r.reply).not.toContain('revoked at the provider')
    expect(s.revoked).toEqual([])
    expect([...s.ms.data.keys()]).toEqual(['A_X_COM'])
  })
  it('removes the only mailbox without naming it', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect outlook').reply)
    await s.send(s.body(nonce, { provider: 'outlook' }))
    await s.flow.handleCommandAsync('c', '/connect remove outlook --local-only')
    expect(s.ms.data.size).toBe(0)
    expect(s.revoked).toEqual([])
  })
})

describe('/connect remove', () => {
  async function connected(s: ReturnType<typeof setup>) {
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    await s.send(s.body(nonce))
  }
  it('revokes at the provider then deletes locally', async () => {
    const s = setup()
    await connected(s)
    const r = await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.revoked).toEqual(['RT'])
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(false)
    expect(r.reply).toContain('Removed')
  })
  it('keeps the local token when revocation fails, so it can be retried', async () => {
    const s = setup(async () => { throw new Error('network') })
    await connected(s)
    const r = await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(true)
    expect(r.reply).toContain('--local-only')
    const r2 = await s.flow.handleCommandAsync('c', '/connect remove gmail --local-only')
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(false)
    expect(r2.reply).toContain('not revoked')
  })
  it('says so when nothing is connected', async () => {
    const r = await setup().flow.handleCommandAsync('c', '/connect remove gmail')
    expect(r.reply).toContain('Nothing connected')
  })
})
