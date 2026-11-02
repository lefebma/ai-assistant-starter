import { describe, it, expect } from 'vitest'
import { createRelay, pkceChallenge, type RelayProvider } from '../src/connect/relay.js'
import { MemoryUsedStore, signState } from '../src/connect/state.js'

const SECRET = 'relay-signing-secret-for-tests-0123456789'
const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'
const CLIENT_SECRET = 'FAKE-CLIENT-SECRET-must-never-leave-relay'
const TOKEN = 'FAKE-REFRESH-TOKEN-must-not-be-logged'
const NONCE = 'nonce-0123456789abcdef'

function setup(opts: { now?: () => number; boxOrigin?: string; exchangeFails?: boolean; handoffStatus?: number } = {}) {
  const logs: unknown[] = []
  const posts: Array<{ url: string; init: RequestInit }> = []
  const exchanged: string[] = []
  const verifiers: string[] = []
  const provider: RelayProvider = {
    authUrl: (state, redirectUri, challenge) =>
      `https://fake-idp.test/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}`,
    exchange: async (code, _redirectUri, verifier) => {
      exchanged.push(code)
      verifiers.push(verifier)
      if (opts.exchangeFails) throw new Error('boom')
      return { account: 'x@y.com', accessToken: 'AT', refreshToken: TOKEN, expiresAt: 123 }
    },
  }
  let t = 1_000_000
  const relay = createRelay({
    publicUrl: 'https://connect.gethavn.ai',
    signingSecret: SECRET,
    boxes: { get: (id) => (id === 'box-1' ? { origin: opts.boxOrigin ?? 'https://box1.example.com', handoffKey: HKEY } : undefined) },
    providers: { fake: provider },
    used: new MemoryUsedStore(),
    now: opts.now ?? (() => t),
    log: (e) => logs.push(e),
    fetchImpl: (async (url: string, init: RequestInit) => {
      posts.push({ url, init })
      return new Response('ok', { status: opts.handoffStatus ?? 200 })
    }) as unknown as typeof fetch,
  })
  return { relay, logs, posts, exchanged, verifiers, advance: (ms: number) => (t += ms), clock: () => t }
}

const start = (r: ReturnType<typeof setup>, q = `provider=fake&box=box-1&nonce=${NONCE}`) =>
  r.relay.handle(new Request(`https://connect.gethavn.ai/start?${q}`))

async function stateFrom(res: Response): Promise<string> {
  return new URL(res.headers.get('location')!).searchParams.get('state')!
}

describe('relay /start', () => {
  it('redirects to the provider with a signed state naming the box', async () => {
    const r = setup()
    const res = await start(r)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.origin).toBe('https://fake-idp.test')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://connect.gethavn.ai/callback')
    const body = JSON.parse(Buffer.from((await stateFrom(res)).split('.')[0], 'base64url').toString())
    expect(body).toMatchObject({ box: 'box-1', provider: 'fake', nonce: NONCE })
  })
  it('refuses unknown box, unknown provider, short nonce', async () => {
    const r = setup()
    expect((await start(r, `provider=fake&box=nope&nonce=${NONCE}`)).status).toBe(400)
    expect((await start(r, `provider=zzz&box=box-1&nonce=${NONCE}`)).status).toBe(400)
    expect((await start(r, 'provider=fake&box=box-1&nonce=abc')).status).toBe(400)
  })
})

describe('relay PKCE', () => {
  it('exchanges with the verifier whose S256 challenge went to the provider, and never puts the verifier in a URL', async () => {
    const r = setup()
    const res = await start(r)
    const loc = new URL(res.headers.get('location')!)
    const challenge = loc.searchParams.get('code_challenge')!
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = encodeURIComponent(loc.searchParams.get('state')!)
    await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${state}`))
    expect(r.verifiers).toHaveLength(1)
    expect(r.verifiers[0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkceChallenge(r.verifiers[0])).toBe(challenge)
    expect(loc.toString()).not.toContain(r.verifiers[0])
  })
  it('gives each sign-in its own verifier', async () => {
    const r = setup()
    const a = new URL((await start(r)).headers.get('location')!).searchParams.get('code_challenge')
    const b = new URL((await start(r, 'provider=fake&box=box-1&nonce=another-nonce-0123456789')).headers.get('location')!).searchParams.get('code_challenge')
    expect(a).not.toBe(b)
  })
})

describe('relay /callback', () => {
  it('hands the result to the registered box over TLS, signed, without storing or logging the token', async () => {
    const r = setup()
    const state = await stateFrom(await start(r))
    const res = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=CODE1&state=${encodeURIComponent(state)}`))
    expect(res.status).toBe(200)
    expect(r.exchanged).toEqual(['CODE1'])
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0].url).toBe('https://box1.example.com/connect/handoff')
    const sent = JSON.parse(r.posts[0].init.body as string)
    expect(sent).toMatchObject({ nonce: NONCE, provider: 'fake', account: 'x@y.com', refreshToken: TOKEN })
    expect((r.posts[0].init.headers as Record<string, string>)['x-connect-signature']).toMatch(/^[0-9a-f]{64}$/)
    const logged = JSON.stringify(r.logs)
    expect(logged).toContain('handoff')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('AT"')
    expect(logged).not.toContain(CLIENT_SECRET)
    expect(await res.text()).not.toContain(TOKEN)
  })
  it('refuses a replayed state without calling the provider again', async () => {
    const r = setup()
    const state = encodeURIComponent(await stateFrom(await start(r)))
    await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${state}`))
    const again = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C2&state=${state}`))
    expect(again.status).toBe(400)
    expect(r.exchanged).toEqual(['C'])
    expect(r.posts).toHaveLength(1)
  })
  it('refuses an expired state', async () => {
    const r = setup()
    const state = encodeURIComponent(await stateFrom(await start(r)))
    r.advance(10 * 60_000 + 1)
    const res = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${state}`))
    expect(res.status).toBe(400)
    expect(r.exchanged).toHaveLength(0)
    expect(r.posts).toHaveLength(0)
  })
  it('refuses a forged state', async () => {
    const r = setup()
    const forged = signState('another-secret-another-secret-another-secret', { box: 'box-1', provider: 'fake', nonce: NONCE }, r.clock())
    const res = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${encodeURIComponent(forged)}`))
    expect(res.status).toBe(400)
    expect(r.posts).toHaveLength(0)
  })
  it('never hands off to a non-https box origin', async () => {
    const r = setup({ boxOrigin: 'http://box1.example.com' })
    const state = encodeURIComponent(await stateFrom(await start(r)))
    const res = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${state}`))
    expect(res.status).toBe(502)
    expect(r.posts).toHaveLength(0)
  })
  it('treats a user denial as a refusal with no exchange or hand-off', async () => {
    const r = setup()
    const state = encodeURIComponent(await stateFrom(await start(r)))
    const res = await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?error=access_denied&state=${state}`))
    expect(res.status).toBe(400)
    expect(r.exchanged).toHaveLength(0)
    expect(r.posts).toHaveLength(0)
  })
  it('reports a failed exchange or box rejection without leaking detail', async () => {
    const a = setup({ exchangeFails: true })
    const sa = encodeURIComponent(await stateFrom(await start(a)))
    expect((await a.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${sa}`))).status).toBe(502)
    const b = setup({ handoffStatus: 401 })
    const sb = encodeURIComponent(await stateFrom(await start(b)))
    expect((await b.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${sb}`))).status).toBe(502)
    expect(JSON.stringify(b.logs)).not.toContain(TOKEN)
  })
})
