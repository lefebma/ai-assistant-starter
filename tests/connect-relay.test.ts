import { describe, it, expect } from 'vitest'
import { createRelay, pkceChallenge, readCapped, seal, unseal, signHandoff, type RelayProvider } from '../src/connect/relay.js'
import { MemoryUsedStore, signState } from '../src/connect/state.js'

const SECRET = 'relay-signing-secret-for-tests-0123456789'
const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'
const CLIENT_SECRET = 'FAKE-CLIENT-SECRET-must-never-leave-relay'
const TOKEN = 'FAKE-REFRESH-TOKEN-must-not-be-logged'
const NONCE = 'nonce-0123456789abcdef'
const HKEY2 = 'second-box-handoff-key-0123456789abcdef'
const SEAL = 'relay-sealing-secret-for-tests-0123456789'

function setup(opts: { now?: () => number; boxOrigin?: string; exchangeFails?: boolean; handoffStatus?: number; label?: string } = {}) {
  const logs: unknown[] = []
  const posts: Array<{ url: string; init: RequestInit }> = []
  const exchanged: string[] = []
  const verifiers: string[] = []
  const revoked: string[] = []
  const provider: RelayProvider = {
    label: 'Fake',
    authOrigin: 'https://fake-idp.test',
    authUrl: (state, redirectUri, challenge) =>
      `https://fake-idp.test/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}`,
    exchange: async (code, _redirectUri, verifier) => {
      exchanged.push(code)
      verifiers.push(verifier)
      if (opts.exchangeFails) throw new Error('boom')
      return { account: 'x@y.com', accessToken: 'AT', refreshToken: TOKEN, expiresAt: 123 }
    },
  }
  // Same as `fake`, but renewed by the relay, so its refresh token is sealed.
  const renewed: RelayProvider = {
    ...provider,
    refresh: async (rt) => ({ accessToken: `fresh-for-${rt}`, expiresAt: 999 }),
    revoke: async (rt) => void revoked.push(rt),
  }
  let t = 1_000_000
  const relay = createRelay({
    publicUrl: 'https://connect.gethavn.ai',
    signingSecret: SECRET,
    sealingSecret: SEAL,
    boxes: {
      get: (id) =>
        id === 'box-1' ? { origin: opts.boxOrigin ?? 'https://box1.example.com', handoffKey: HKEY, label: opts.label ?? "Sam's assistant" }
        : id === 'box-2' ? { origin: 'https://box2.example.com', handoffKey: HKEY2 } : undefined,
    },
    providers: { fake: provider, renewed },
    used: new MemoryUsedStore(),
    now: opts.now ?? (() => t),
    log: (e) => logs.push(e),
    fetchImpl: (async (url: string, init: RequestInit) => {
      posts.push({ url, init })
      return new Response('ok', { status: opts.handoffStatus ?? 200 })
    }) as unknown as typeof fetch,
  })
  return { relay, logs, posts, exchanged, verifiers, revoked, advance: (ms: number) => (t += ms), clock: () => t }
}

/** The click on the confirmation page: a same-origin form POST. */
const start = (r: ReturnType<typeof setup>, q = `provider=fake&box=box-1&nonce=${NONCE}`, headers: Record<string, string> = { origin: 'https://connect.gethavn.ai', 'sec-fetch-site': 'same-origin' }) =>
  r.relay.handle(new Request('https://connect.gethavn.ai/start', { method: 'POST', body: q, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }))

const confirmPage = (r: ReturnType<typeof setup>, q = `provider=fake&box=box-1&nonce=${NONCE}`) =>
  r.relay.handle(new Request(`https://connect.gethavn.ai/start?${q}`))

async function stateFrom(res: Response): Promise<string> {
  return new URL(res.headers.get('location')!).searchParams.get('state')!
}

describe('relay confirmation page', () => {
  it('names the assistant and the provider, and never redirects', async () => {
    const r = setup()
    const res = await confirmPage(r)
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
    const body = await res.text()
    expect(body).toContain('Sam&#39;s assistant')
    expect(body).toContain('Continue to Fake')
    expect(body).toContain('If someone sent it to you, close this page')
    expect(body).toContain('method="post" action="/start"')
  })
  it('cannot be framed, and lets its form go only to itself and the provider', async () => {
    const res = await confirmPage(setup())
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self' https://fake-idp.test")
    expect(csp).toContain("default-src 'none'")
  })
  it('escapes the label and the link fields', async () => {
    const r = setup({ label: '<script>x</script>' })
    const body = await (await confirmPage(r, `provider=fake&box=box-1&nonce=${encodeURIComponent('"><img src=x>-0123456789')}`)).text()
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('<img')
  })
  it('falls back to the box id when the box has no label', async () => {
    expect(await (await confirmPage(setup(), `provider=fake&box=box-2&nonce=${NONCE}`)).text()).toContain('<strong>box-2</strong>')
  })
  it('refuses a click that did not come from the page', async () => {
    const r = setup()
    expect((await start(r, undefined, {})).status).toBe(400)
    expect((await start(r, undefined, { origin: 'https://evil.example' })).status).toBe(400)
    expect((await start(r, undefined, { origin: 'https://connect.gethavn.ai', 'sec-fetch-site': 'cross-site' })).status).toBe(400)
    expect(JSON.stringify(r.logs)).toContain('cross_site')
  })
})

describe('relay /start', () => {
  it('redirects to the provider with a signed state naming the box', async () => {
    const r = setup()
    const res = await start(r)
    expect(res.status).toBe(303)
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
    expect((await confirmPage(r, `provider=fake&box=nope&nonce=${NONCE}`)).status).toBe(400)
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

describe('sealed refresh tokens', () => {
  async function connectRenewed(r: ReturnType<typeof setup>, box = 'box-1') {
    const state = await stateFrom(await start(r, `provider=renewed&box=${box}&nonce=${NONCE}`))
    await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${encodeURIComponent(state)}`))
    return JSON.parse(r.posts.at(-1)!.init.body as string) as { refreshToken: string }
  }
  const boxPost = (r: ReturnType<typeof setup>, path: string, b: Record<string, unknown>, key = HKEY) => {
    const raw = JSON.stringify({ ts: r.clock(), ...b })
    return r.relay.handle(new Request(`https://connect.gethavn.ai${path}`, { method: 'POST', body: raw, headers: { 'x-connect-signature': signHandoff(key, raw) } }))
  }

  it('hands the box a token sealed to it, never the provider token', async () => {
    const r = setup()
    const sent = await connectRenewed(r)
    expect(sent.refreshToken).not.toContain(TOKEN)
    expect(sent.refreshToken.startsWith('s1.')).toBe(true)
    expect(await unseal(SEAL, 'box-1', 'renewed', sent.refreshToken)).toBe(TOKEN)
    expect(await unseal(SEAL, 'box-2', 'renewed', sent.refreshToken)).toBeNull()
    expect(await unseal(SEAL, 'box-1', 'fake', sent.refreshToken)).toBeNull()
  })
  it('leaves tokens the box renews itself unsealed', async () => {
    const r = setup()
    const state = await stateFrom(await start(r))
    await r.relay.handle(new Request(`https://connect.gethavn.ai/callback?code=C&state=${encodeURIComponent(state)}`))
    expect(JSON.parse(r.posts[0].init.body as string).refreshToken).toBe(TOKEN)
  })
  it('renews only for the box the token was sealed to', async () => {
    const r = setup()
    const { refreshToken } = await connectRenewed(r)
    const ok = await boxPost(r, '/refresh', { box: 'box-1', provider: 'renewed', refreshToken })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ accessToken: `fresh-for-${TOKEN}`, expiresAt: 999 })
    // Another registered box, signing correctly with its own key, holding box-1's token.
    const stolen = await boxPost(r, '/refresh', { box: 'box-2', provider: 'renewed', refreshToken }, HKEY2)
    expect(stolen.status).toBe(401)
    expect(await stolen.json()).toEqual({ error: 'not_yours' })
    // A raw provider token is refused too.
    expect((await boxPost(r, '/refresh', { box: 'box-1', provider: 'renewed', refreshToken: TOKEN })).status).toBe(401)
  })
  it('reseals a rotated refresh token', async () => {
    const r = setup()
    const sealed = await seal(SEAL, 'box-1', 'renewed', 'OLD')
    const raw = JSON.stringify({ box: 'box-1', provider: 'renewed', refreshToken: sealed, ts: r.clock() })
    const relay = createRelay({
      publicUrl: 'https://connect.gethavn.ai', signingSecret: SECRET, sealingSecret: SEAL,
      boxes: { get: () => ({ origin: 'https://b', handoffKey: HKEY }) },
      providers: { g: { label: 'G', authOrigin: 'https://g', authUrl: () => '', exchange: async () => { throw new Error() }, refresh: async () => ({ accessToken: 'a', expiresAt: 1, refreshToken: 'ROTATED' }) } },
      used: new MemoryUsedStore(), now: () => r.clock(),
    })
    const res = await relay.handle(new Request('https://x/refresh', { method: 'POST', body: raw.replace('"renewed"', '"g"'), headers: { 'x-connect-signature': signHandoff(HKEY, raw.replace('"renewed"', '"g"')) } }))
    // The token was sealed for provider "renewed", so under "g" it is refused: provider is part of the seal.
    expect(res.status).toBe(401)
    const sealedG = await seal(SEAL, 'box-1', 'g', 'OLD')
    const rawG = JSON.stringify({ box: 'box-1', provider: 'g', refreshToken: sealedG, ts: r.clock() })
    const resG = await relay.handle(new Request('https://x/refresh', { method: 'POST', body: rawG, headers: { 'x-connect-signature': signHandoff(HKEY, rawG) } }))
    const out = (await resG.json()) as { refreshToken: string }
    expect(out.refreshToken.startsWith('s1.')).toBe(true)
    expect(await unseal(SEAL, 'box-1', 'g', out.refreshToken)).toBe('ROTATED')
  })
  it('revokes the unsealed token at the provider, for its own box only', async () => {
    const r = setup()
    const { refreshToken } = await connectRenewed(r)
    expect((await boxPost(r, '/revoke', { box: 'box-2', provider: 'renewed', refreshToken }, HKEY2)).status).toBe(401)
    expect(r.revoked).toEqual([])
    expect((await boxPost(r, '/revoke', { box: 'box-1', provider: 'renewed', refreshToken })).status).toBe(200)
    expect(r.revoked).toEqual([TOKEN])
  })
  it('never logs a token on renewal or revocation', async () => {
    const r = setup()
    const { refreshToken } = await connectRenewed(r)
    await boxPost(r, '/refresh', { box: 'box-1', provider: 'renewed', refreshToken })
    await boxPost(r, '/revoke', { box: 'box-1', provider: 'renewed', refreshToken })
    const logged = JSON.stringify(r.logs)
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain(refreshToken)
    expect(logged).not.toContain('fresh-for')
  })
})

describe('readCapped', () => {
  it('refuses a declared or streamed body over the cap', async () => {
    expect(await readCapped(new Request('https://x', { method: 'POST', body: 'abc' }), 10)).toBe('abc')
    expect(await readCapped(new Request('https://x', { method: 'POST', body: 'x'.repeat(11) }), 10)).toBeNull()
    const lying = new Request('https://x', { method: 'POST', body: 'x'.repeat(50), headers: { 'content-length': '5' } })
    expect(await readCapped(lying, 10)).toBeNull()
  })
})
