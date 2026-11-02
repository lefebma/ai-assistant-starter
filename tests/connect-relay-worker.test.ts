/**
 * Card #206: the relay Worker. The real Worker and Durable Object run against
 * an in-memory stand-in for Durable Object storage. Two Worker "copies" share
 * one store, which is the case a per-isolate memory could not cover.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import worker, { RelayStore, cleanOrigin, providersFrom, durableUsedStore, type Env } from '../deploy/connect-relay/worker.js'
import { signState } from '../src/connect/state.js'

const ADMIN = 'admin-secret-token'
const SECRET = 'relay-signing-secret-for-tests-0123456789'

function makeEnv(over: Partial<Env> = {}): Env {
  const data = new Map<string, unknown>()
  const instance = new RelayStore({
    storage: {
      get: async (k: string) => structuredClone(data.get(k)) as never,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      delete: async (k: string) => data.delete(k),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))) as never,
    },
  })
  return {
    STORE: { idFromName: (n: string) => n, get: () => instance },
    PUBLIC_URL: 'https://connect.gethavn.ai',
    SIGNING_SECRET: SECRET,
    ADMIN_TOKEN_SHA256: createHash('sha256').update(ADMIN).digest('hex'),
    MS_CLIENT_ID: 'ms-client',
    ...over,
  }
}

const adminCall = (env: Env, path: string, init: RequestInit = {}, token = ADMIN) =>
  worker.fetch(new Request(`https://connect.gethavn.ai${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }), env)

async function register(env: Env, box: string, origin = 'https://box.example.com') {
  return adminCall(env, `/admin/boxes/${box}`, { method: 'POST', body: JSON.stringify({ origin }) })
}

describe('admin routes', () => {
  it('registers a box and hands back a fresh key once; the listing never shows keys', async () => {
    const env = makeEnv()
    const r = await register(env, 'havn-test')
    expect(r.status).toBe(200)
    const out = (await r.json()) as { box: string; origin: string; handoffKey: string }
    expect(out).toMatchObject({ box: 'havn-test', origin: 'https://box.example.com' })
    expect(out.handoffKey).toMatch(/^[0-9a-f]{64}$/)
    const again = (await (await register(env, 'havn-test')).json()) as { handoffKey: string }
    expect(again.handoffKey).not.toBe(out.handoffKey)
    const list = await (await adminCall(env, '/admin/boxes')).text()
    expect(list).toContain('havn-test')
    expect(list).not.toContain(again.handoffKey)
    expect(list).not.toContain('handoffKey')
  })
  it('refuses a wrong admin token, a bad box id, and anything but a bare https origin', async () => {
    const env = makeEnv()
    expect((await adminCall(env, '/admin/boxes', {}, 'nope')).status).toBe(401)
    expect((await worker.fetch(new Request('https://connect.gethavn.ai/admin/boxes'), env)).status).toBe(401)
    expect((await register(env, 'Bad_Box')).status).toBe(400)
    for (const o of ['http://box.example.com', 'https://box.example.com/path', 'https://u:p@box.example.com', 'not a url']) {
      expect((await register(env, 'b1', o)).status).toBe(400)
    }
  })
  it('removes a box, after which its links are refused', async () => {
    const env = makeEnv()
    await register(env, 'b1')
    expect((await adminCall(env, '/admin/boxes/b1', { method: 'DELETE' })).status).toBe(200)
    const res = await worker.fetch(new Request('https://connect.gethavn.ai/start?provider=outlook&box=b1&nonce=nonce-0123456789abcdef'), env)
    expect(res.status).toBe(400)
  })
})

describe('relay through the Worker', () => {
  it('starts an Outlook sign-in for a registered box with PKCE', async () => {
    const env = makeEnv()
    await register(env, 'b1')
    const res = await worker.fetch(new Request('https://connect.gethavn.ai/start?provider=outlook&box=b1&nonce=nonce-0123456789abcdef'), env)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(loc.host).toBe('login.microsoftonline.com')
    expect(loc.searchParams.get('client_id')).toBe('ms-client')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://connect.gethavn.ai/callback')
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
  })
  it('does not offer Gmail until both Google settings exist', async () => {
    expect(Object.keys(providersFrom(makeEnv()))).toEqual(['outlook'])
    expect(Object.keys(providersFrom(makeEnv({ GOOGLE_CLIENT_ID: 'g' })))).toEqual(['outlook'])
    expect(Object.keys(providersFrom(makeEnv({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' }))).sort()).toEqual(['gmail', 'outlook'])
    const env = makeEnv()
    await register(env, 'b1')
    expect((await worker.fetch(new Request('https://connect.gethavn.ai/start?provider=gmail&box=b1&nonce=nonce-0123456789abcdef'), env)).status).toBe(400)
  })
  it('refuses a replayed state even when the replay reaches another copy of the Worker', async () => {
    const env = makeEnv()
    await register(env, 'b1')
    const state = encodeURIComponent(signState(SECRET, { box: 'b1', provider: 'outlook', nonce: 'nonce-0123456789abcdef' }))
    // A denial still spends the state, and needs no provider or box on the network.
    const first = await worker.fetch(new Request(`https://connect.gethavn.ai/callback?error=access_denied&state=${state}`), env)
    expect(await first.text()).toContain('not completed')
    const copyB = { ...env } // a second isolate: new relay instance, same Durable Object
    const replay = await worker.fetch(new Request(`https://connect.gethavn.ai/callback?code=C&state=${state}`), copyB)
    expect(replay.status).toBe(400)
    expect(await replay.text()).toContain('already used')
  })
})

describe('durable used store', () => {
  it('marks a key once and forgets it after it expires', async () => {
    const used = durableUsedStore(makeEnv())
    expect(await used.markUsed('k', 100, 0)).toBe(true)
    expect(await used.markUsed('k', 100, 50)).toBe(false)
    expect(await used.markUsed('other', 300, 200)).toBe(true) // sweeps k
    expect(await used.markUsed('k', 400, 200)).toBe(true)
  })
})

describe('cleanOrigin', () => {
  it('keeps a bare https origin and drops a trailing slash', () => {
    expect(cleanOrigin('https://box.example.com/')).toBe('https://box.example.com')
    expect(cleanOrigin('https://box.example.com:8443')).toBe('https://box.example.com:8443')
    expect(cleanOrigin('https://box.example.com?x=1')).toBeNull()
    expect(cleanOrigin(42)).toBeNull()
  })
})
