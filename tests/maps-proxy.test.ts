/**
 * Card #266: the maps proxy Worker and the box's maps client. The real Worker
 * code runs against an in-memory stand-in for Durable Objects and a fake
 * Google; the box's client talks to it through a fetch that calls the Worker
 * directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import worker, { BoxMaps, CACHE_TTL_MS, type Env } from '../deploy/maps-proxy/worker.js'
import { sha256Hex } from '../src/assurance/witness-protocol.js'
import { createMapsClient, MAPS_TIMEOUT_MS, TRAVEL_TIME_UNAVAILABLE } from '../src/maps/client.js'
import { GOOGLE_ATTRIBUTION } from '../src/maps/google.js'
import { USD_PER_1000, microUsdFor } from '../src/maps/pricing.js'
import { recordMapsSpend, readAiUsage, AI_USAGE_FILE } from '../src/ai-usage.js'
import { MANAGED_AI_FILE } from '../src/ai-limit.js'
import { logger } from '../src/logger.js'
import { connectScript } from '../scripts/hosted/maps-token.js'

const ADMIN = 'admin-secret-token'
const HOME = '12 Private Lane, Oakville ON'
const OFFICE = '100 King St W, Toronto'
const CAFE = 'Starbucks King and Bay'

type Google = { calls: string[]; bodies: string[]; mode: 'ok' | 'down' | 'hang' | 'empty' }

function fakeGoogle(g: Google): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    g.calls.push(url)
    g.bodies.push(String(init?.body ?? ''))
    if (g.mode === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))))
    }
    if (g.mode === 'down') return new Response('{"error":{"message":"backend"}}', { status: 503 })
    if (url.includes('geocode')) {
      return Response.json(g.mode === 'empty' ? { status: 'ZERO_RESULTS', results: [] } : { status: 'OK', results: [{ formatted_address: OFFICE, geometry: { location: { lat: 43.65, lng: -79.38 } } }] })
    }
    if (url.includes('computeRoutes')) return Response.json({ routes: [{ duration: '1520s', staticDuration: '1200s', distanceMeters: 31000 }] })
    return Response.json({ places: [{ id: 'p1', displayName: { text: 'Starbucks' }, formattedAddress: '199 Bay St', location: { latitude: 43.648, longitude: -79.379 } }] })
  }) as typeof fetch
}

function makeEnv(g: Google): Env & { clock: { now: number } } {
  const instances = new Map<string, BoxMaps>()
  const clock = { now: Date.parse('2026-11-10T15:00:00Z') }
  const env = {
    clock,
    ADMIN_TOKEN_SHA256: '',
    GOOGLE_MAPS_API_KEY: 'google-key-on-the-worker',
    DEFAULT_MONTHLY_REQUESTS: '1000',
    GOOGLE_FETCH: fakeGoogle(g),
    MAPS: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = id as string
        let inst = instances.get(name)
        if (!inst) {
          const store = new Map<string, unknown>()
          inst = new BoxMaps({
            storage: {
              get: async (k: string) => structuredClone(store.get(k)) as never,
              put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
              delete: async (k: string) => store.delete(k),
              list: async ({ prefix }: { prefix: string }) => new Map([...store].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])) as never,
            },
            blockConcurrencyWhile: (fn) => fn(),
          }, env as unknown as Env)
          inst.now = () => clock.now
          instances.set(name, inst)
        }
        return inst
      },
    },
  }
  return env as unknown as Env & { clock: { now: number } }
}

const call = (env: Env, path: string, token: string | null, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://maps.test${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } }), env)

const post = (env: Env, path: string, token: string | null, body: unknown) => call(env, path, token, { method: 'POST', body: JSON.stringify(body) })

async function issue(env: Env, box: string): Promise<string> {
  const r = await post(env, `/v1/admin/boxes/${box}/token`, ADMIN, {})
  expect(r.status).toBe(200)
  return ((await r.json()) as { token: string }).token
}

const viaWorker = (env: Env) => ((u: string, init: RequestInit) => worker.fetch(new Request(u, init), env)) as typeof fetch

let g: Google, env: Env & { clock: { now: number } }, logs: string[], spend: number[]
beforeEach(async () => {
  g = { calls: [], bodies: [], mode: 'ok' }
  env = makeEnv(g)
  env.ADMIN_TOKEN_SHA256 = await sha256Hex(ADMIN)
  logs = []
  spend = []
  const capture = (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  vi.spyOn(console, 'log').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'error').mockImplementation(capture)
  for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => capture(...a)) as never)
})
afterEach(() => vi.restoreAllMocks())

describe('maps proxy Worker: tokens', () => {
  it('refuses a missing token, an unknown one and another box\'s secret', async () => {
    const a = await issue(env, 'box-a')
    await issue(env, 'box-b')
    expect((await post(env, '/v1/geocode', null, { text: OFFICE })).status).toBe(401)
    expect((await post(env, '/v1/geocode', 'box-a.wrong', { text: OFFICE })).status).toBe(401)
    expect((await post(env, '/v1/geocode', 'box-z.' + a.split('.')[1], { text: OFFICE })).status).toBe(401)
    expect((await post(env, '/v1/geocode', `box-b.${a.split('.')[1]}`, { text: OFFICE })).status).toBe(401)
    expect((await call(env, '/v1/admin/usage', a)).status).toBe(401)
    expect(g.calls).toHaveLength(0)
    expect((await post(env, '/v1/geocode', a, { text: OFFICE })).status).toBe(200)
  })

  it('a revoked token is refused and no other box is affected', async () => {
    const a = await issue(env, 'box-a')
    const b = await issue(env, 'box-b')
    expect((await post(env, '/v1/admin/boxes/box-a/revoke', ADMIN, {})).status).toBe(200)
    expect((await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE })).status).toBe(401)
    expect((await post(env, '/v1/route', b, { origin: HOME, destination: OFFICE })).status).toBe(200)
    // A new token brings it back; the revoked one stays dead.
    const a2 = await issue(env, 'box-a')
    expect((await post(env, '/v1/route', a2, { origin: HOME, destination: OFFICE })).status).toBe(200)
    expect((await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE })).status).toBe(401)
  })

  it('passes nothing else through', async () => {
    const a = await issue(env, 'box-a')
    for (const [method, path] of [['GET', '/v1/geocode'], ['POST', '/v1/usage'], ['POST', '/v1/directions'], ['POST', '/maps/api/geocode/json'], ['POST', '/token'], ['GET', '/report']]) {
      expect((await call(env, path, a, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status).toBe(404)
    }
    expect((await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE, mode: 'FLY' })).status).toBe(400)
    expect((await post(env, '/v1/geocode', a, { text: 'x'.repeat(301) })).status).toBe(400)
    expect(g.calls).toHaveLength(0)
  })
})

describe('maps proxy Worker: calls, quota, cost', () => {
  it('asks Google for a traffic-aware route with the departure time, and never sends the key to the box', async () => {
    const a = await issue(env, 'box-a')
    const departAt = new Date(env.clock.now + 3600_000).toISOString()
    const r = await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE, departAt })
    const out = (await r.json()) as { result: { durationSeconds: number; staticDurationSeconds: number }; usd: number }
    expect(out.result).toMatchObject({ durationSeconds: 1520, staticDurationSeconds: 1200, distanceMeters: 31000, mode: 'DRIVE' })
    expect(out.usd).toBe(USD_PER_1000.route / 1000)
    const sent = JSON.parse(g.bodies[0])
    expect(sent).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', departureTime: departAt })
    expect(JSON.stringify(out)).not.toContain('google-key-on-the-worker')

    await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE, mode: 'TRANSIT', departAt })
    const transit = JSON.parse(g.bodies[1])
    expect(transit.travelMode).toBe('TRANSIT')
    expect(transit.routingPreference).toBeUndefined()
  })

  it('refuses over quota with a clear error, per box', async () => {
    const a = await issue(env, 'box-a')
    const b = await issue(env, 'box-b')
    expect(await (await post(env, '/v1/admin/boxes/box-a/quota', ADMIN, { monthlyRequests: 2 })).json()).toEqual({ quota: 2 })
    expect((await post(env, '/v1/places', a, { text: CAFE })).status).toBe(200)
    expect((await post(env, '/v1/places', a, { text: CAFE })).status).toBe(200)
    const over = await post(env, '/v1/places', a, { text: CAFE })
    expect(over.status).toBe(429)
    expect(await over.json()).toMatchObject({ error: 'over_quota' })
    expect(g.calls).toHaveLength(2)
    expect((await post(env, '/v1/places', b, { text: CAFE })).status).toBe(200)

    // A new month starts a fresh count.
    env.clock.now = Date.parse('2026-12-01T00:00:01Z')
    expect((await post(env, '/v1/places', a, { text: CAFE })).status).toBe(200)
  })

  it('records requests and cost per box per month, and a box reads only its own', async () => {
    const a = await issue(env, 'box-a')
    const b = await issue(env, 'box-b')
    await post(env, '/v1/geocode', a, { text: OFFICE })
    await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE })
    await post(env, '/v1/places', b, { text: CAFE })
    const usageA = (await (await call(env, '/v1/usage', a)).json()) as { month: string; requests: number; usd: number }
    expect(usageA).toMatchObject({ month: '2026-11', requests: 2, usd: (microUsdFor('geocode') + microUsdFor('route')) / 1e6, quota: 1000 })
    const all = (await (await call(env, '/v1/admin/usage?month=2026-11', ADMIN)).json()) as { boxes: Array<{ box: string; requests: number; usd: number }> }
    expect(all.boxes.map((x) => [x.box, x.requests, x.usd])).toEqual([['box-a', 2, 0.015], ['box-b', 1, 0.032]])
  })

  it('a failed Google call costs nothing but still counts toward the quota', async () => {
    const a = await issue(env, 'box-a')
    g.mode = 'down'
    const r = await post(env, '/v1/route', a, { origin: HOME, destination: OFFICE })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'upstream', usd: 0 })
    expect(await (await call(env, '/v1/usage', a)).json()).toMatchObject({ requests: 1, usd: 0 })
  })
})

describe('maps proxy Worker: geocode cache', () => {
  it('serves a repeat lookup from the cache, free, for up to 30 days', async () => {
    const a = await issue(env, 'box-a')
    const first = (await (await post(env, '/v1/geocode', a, { text: OFFICE })).json()) as { cached?: boolean; usd: number }
    expect(first.cached).toBeUndefined()
    const second = (await (await post(env, '/v1/geocode', a, { text: `  ${OFFICE.toUpperCase()} ` })).json()) as { cached: boolean; usd: number; result: unknown }
    expect(second).toMatchObject({ cached: true, usd: 0, result: { lat: 43.65, lng: -79.38 } })
    expect(g.calls).toHaveLength(1)
    expect(await (await call(env, '/v1/usage', a)).json()).toMatchObject({ requests: 1, cacheHits: 1 })

    env.clock.now += CACHE_TTL_MS
    await post(env, '/v1/geocode', a, { text: OFFICE })
    expect(g.calls).toHaveLength(2)
  })

  it('one box never sees another box\'s lookups', async () => {
    const a = await issue(env, 'box-a')
    const b = await issue(env, 'box-b')
    await post(env, '/v1/geocode', a, { text: HOME })
    const fromB = (await (await post(env, '/v1/geocode', b, { text: HOME })).json()) as { cached?: boolean }
    expect(fromB.cached).toBeUndefined()
    expect(g.calls).toHaveLength(2)
  })

  it('the daily cron drops entries older than 30 days', async () => {
    const a = await issue(env, 'box-a')
    await post(env, '/v1/geocode', a, { text: OFFICE })
    env.clock.now += CACHE_TTL_MS + 1
    await worker.scheduled({}, env)
    expect(logs.some((l) => l.includes('"dropped":1'))).toBe(true)
  })
})

describe('no addresses in any log line', () => {
  it('the Worker and the box log box, call, status and cost only', async () => {
    const a = await issue(env, 'box-a')
    const client = createMapsClient({ proxyUrl: 'https://maps.test', proxyToken: a }, { fetch: viaWorker(env), recordSpend: (u) => spend.push(u) })
    await client.geocode(HOME)
    await client.geocode(HOME)
    await client.route({ origin: HOME, destination: CAFE, departAt: new Date(env.clock.now + 600_000) })
    await client.placeSearch(CAFE)
    g.mode = 'down'
    await client.route({ origin: HOME, destination: OFFICE })
    g.mode = 'empty'
    await client.geocode('Room 4B, 100 Nowhere Rd')
    await post(env, '/v1/admin/boxes/box-a/revoke', ADMIN, {})
    await client.placeSearch(CAFE)
    expect(logs.length).toBeGreaterThan(5)
    const all = logs.join('\n').toLowerCase()
    for (const secret of [HOME, OFFICE, CAFE, 'Private Lane', 'Oakville', 'Starbucks', 'King', 'Nowhere', '199 Bay', '43.6', 'google-key-on-the-worker', a.split('.')[1]]) {
      expect(all).not.toContain(secret.toLowerCase())
    }
    for (const line of logs.filter((l) => l.startsWith('{"box"'))) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(expect.arrayContaining(['box', 'call', 'status', 'usd']))
      expect(Object.keys(JSON.parse(line)).every((k) => ['box', 'call', 'status', 'usd', 'cached'].includes(k))).toBe(true)
    }
  })
})

describe('box maps client', () => {
  it('hosted: goes through the Worker, records each call\'s cost, credits Google', async () => {
    const a = await issue(env, 'box-a')
    const client = createMapsClient({ proxyUrl: 'https://maps.test/', proxyToken: a, googleKey: 'ignored-on-hosted' }, { fetch: viaWorker(env), recordSpend: (u) => spend.push(u) })
    expect(client.mode).toBe('proxy')
    expect(client.attribution).toBe(GOOGLE_ATTRIBUTION)
    expect(await client.geocode(OFFICE)).toEqual({ ok: true, value: { lat: 43.65, lng: -79.38, address: OFFICE } })
    expect(await client.geocode(OFFICE)).toMatchObject({ ok: true })
    const route = await client.route({ origin: { lat: 43.4, lng: -79.7 }, destination: OFFICE, mode: 'WALK' })
    expect(route).toMatchObject({ ok: true, value: { durationSeconds: 1520, mode: 'WALK' } })
    expect(await client.placeSearch(CAFE)).toMatchObject({ ok: true, value: [{ name: 'Starbucks', lat: 43.648 }] })
    expect(spend).toEqual([0.005, 0.01, 0.032])
    expect(await client.usage()).toMatchObject({ ok: true, value: { requests: 3, usd: 0.047 } })
    expect(g.calls.every((u) => !u.includes('ignored-on-hosted'))).toBe(true)
  })

  it('hosted: bad token, revoked token and over quota come back as reasons, not throws', async () => {
    const a = await issue(env, 'box-a')
    const bad = createMapsClient({ proxyUrl: 'https://maps.test', proxyToken: 'box-a.nope' }, { fetch: viaWorker(env) })
    expect(await bad.route({ origin: HOME, destination: OFFICE })).toEqual({ ok: false, reason: 'unauthorized' })
    const client = createMapsClient({ proxyUrl: 'https://maps.test', proxyToken: a }, { fetch: viaWorker(env), recordSpend: () => {} })
    await post(env, '/v1/admin/boxes/box-a/quota', ADMIN, { monthlyRequests: 0 })
    expect(await client.route({ origin: HOME, destination: OFFICE })).toEqual({ ok: false, reason: 'over_quota' })
    await post(env, '/v1/admin/boxes/box-a/revoke', ADMIN, {})
    expect(await client.route({ origin: HOME, destination: OFFICE })).toEqual({ ok: false, reason: 'unauthorized' })
    expect(TRAVEL_TIME_UNAVAILABLE).toBe('travel time not available')
  })

  it('gives up within the time limit when the Worker or Google hangs', async () => {
    expect(MAPS_TIMEOUT_MS).toBe(5000)
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch
    const proxied = createMapsClient({ proxyUrl: 'https://maps.test', proxyToken: 'box-a.x' }, { fetch: hang, timeoutMs: 50 })
    const t0 = Date.now()
    expect(await proxied.route({ origin: HOME, destination: OFFICE })).toEqual({ ok: false, reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(1000)

    g.mode = 'hang'
    const direct = createMapsClient({ googleKey: 'customer-key' }, { fetch: fakeGoogle(g), timeoutMs: 50 })
    expect(await direct.geocode(OFFICE)).toEqual({ ok: false, reason: 'timeout' })

    const down = createMapsClient({ proxyUrl: 'https://maps.test', proxyToken: 'box-a.x' }, { fetch: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
    expect(await down.placeSearch(CAFE)).toEqual({ ok: false, reason: 'upstream' })
  })

  it('self-install: calls Google with the customer\'s own key and meters nothing', async () => {
    const client = createMapsClient({ googleKey: 'customer-key' }, { fetch: fakeGoogle(g), recordSpend: (u) => spend.push(u), now: () => env.clock.now })
    expect(client.mode).toBe('direct')
    expect(client.attribution).toBe(GOOGLE_ATTRIBUTION)
    expect(await client.geocode(OFFICE)).toMatchObject({ ok: true, value: { lat: 43.65 } })
    expect(await client.route({ origin: HOME, destination: OFFICE, departAt: new Date(env.clock.now + 3600_000) })).toMatchObject({ ok: true, value: { durationSeconds: 1520 } })
    expect(await client.placeSearch(CAFE)).toMatchObject({ ok: true })
    expect(g.calls[0]).toMatch(/^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?.*key=customer-key/)
    expect(g.calls[1]).toBe('https://routes.googleapis.com/directions/v2:computeRoutes')
    expect(g.calls[2]).toBe('https://places.googleapis.com/v1/places:searchText')
    expect(spend).toEqual([])
    expect(await client.usage()).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('nothing configured, or an unbuilt provider: not available, never a throw', async () => {
    const f = vi.fn() as unknown as typeof fetch
    for (const cfg of [{}, { proxyUrl: 'https://maps.test' }, { googleKey: 'k', provider: 'mapbox' }]) {
      const client = createMapsClient(cfg, { fetch: f })
      expect(client.mode).toBe('off')
      expect(client.attribution).toBeNull()
      expect(await client.geocode(OFFICE)).toEqual({ ok: false, reason: 'not_configured' })
      expect(await client.route({ origin: HOME, destination: OFFICE })).toEqual({ ok: false, reason: 'not_configured' })
      expect(await client.placeSearch(CAFE)).toEqual({ ok: false, reason: 'not_configured' })
    }
    expect(f).not.toHaveBeenCalled()
  })
})

describe('maps spend counts toward the monthly allowance', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'maps-spend-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('adds to this month\'s total on a managed box and keeps the maps part apart', () => {
    const now = new Date('2026-11-10T12:00:00Z')
    recordMapsSpend(0.01, { storeDir: dir, now })
    expect(readAiUsage(dir)).toBeNull()
    writeFileSync(join(dir, MANAGED_AI_FILE), JSON.stringify({ capUsd: 40 }))
    writeFileSync(join(dir, AI_USAGE_FILE), JSON.stringify({ month: '2026-11', usd: 12.5 }))
    recordMapsSpend(0.01, { storeDir: dir, now })
    recordMapsSpend(0.032, { storeDir: dir, now })
    expect(JSON.parse(readFileSync(join(dir, AI_USAGE_FILE), 'utf8'))).toEqual({ month: '2026-11', usd: 12.542, mapsUsd: 0.042, capUsd: 40 })
  })
})

describe('provisioning a box token', () => {
  it('writes the token to the vault over stdin and only the URL to .env', () => {
    const s = connectScript('https://havn-maps.example.workers.dev', 'havn-leif.secretvalue')
    expect(s).not.toContain('secretvalue')
    expect(s).toContain('vault-cli.js set MAPS_PROXY_TOKEN')
    expect(s).toContain("printf 'MAPS_PROXY_URL=%s\\n'")
    expect(s).not.toMatch(/MAPS_PROXY_TOKEN=%s/)
  })
})
