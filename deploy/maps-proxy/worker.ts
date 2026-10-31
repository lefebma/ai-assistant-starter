/**
 * havn-maps: the Google Maps proxy for hosted boxes (card #266). Havn's Google
 * Maps Platform key lives here as a Worker secret and never on a box. Each box
 * has its own token, its own monthly request quota and its own geocode cache,
 * all in one Durable Object per box.
 *
 * Box routes take `Authorization: Bearer <box>.<secret>`:
 *   POST /v1/geocode {text}                                 -> {result, usd, cached}
 *   POST /v1/route   {origin, destination, departAt?, mode?} -> {result, usd}
 *   POST /v1/places  {text}                                 -> {result, usd}
 *   GET  /v1/usage                                          -> {month, requests, usd, quota, ...}
 * Errors: 401 unauthorized, 429 over_quota, 400 bad_request, 404 not_found,
 * 502 upstream, 504 timeout, each as {error, usd}.
 *
 * Admin routes take `Authorization: Bearer <admin token>` (its SHA-256 is the
 * ADMIN_TOKEN_SHA256 secret):
 *   POST /v1/admin/boxes/<box>/token   -> {token}  (replaces any earlier token, lifts a revoke)
 *   POST /v1/admin/boxes/<box>/revoke  -> {ok}     (that box only; nothing else changes)
 *   POST /v1/admin/boxes/<box>/quota {monthlyRequests} -> {quota}
 *   GET  /v1/admin/usage?month=YYYY-MM -> {month, boxes: [...]}
 *
 * Nothing else is passed to Google. Logs hold box, call, status and cost only:
 * never an address, place name or route endpoint. A daily cron drops geocode
 * cache entries older than 30 days (Google's limit for stored coordinates).
 * Deploy and setup: deploy/maps-proxy/README.md.
 */
import { BOX_NAME, sha256Hex } from '../../src/assurance/witness-protocol.js'
import { cleanRouteRequest, cleanText, googleGeocode, googlePlaces, googleRoute, type Outcome, type Unavailable } from '../../src/maps/google.js'
import { microToUsd, type MapsCall } from '../../src/maps/pricing.js'

// --- the slice of the Workers runtime this uses -------------------------------

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}
interface DurableObjectState {
  storage: DurableObjectStorage
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

export interface Env {
  MAPS: DurableObjectNamespace
  ADMIN_TOKEN_SHA256: string
  GOOGLE_MAPS_API_KEY: string
  /** Monthly requests a box gets until an admin sets its own. Default 1000. */
  DEFAULT_MONTHLY_REQUESTS?: string
  /** Test seam: the fetch used to reach Google. */
  GOOGLE_FETCH?: typeof fetch
}

// --- helpers ---------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1] : null
}

/** Constant-time comparison of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const utcMonth = (ms: number) => new Date(ms).toISOString().slice(0, 7)

/** The only log line this Worker writes about a request. No request content. */
function logLine(box: string, call: string, status: number | string, microUsd: number, cached = false): void {
  console.log(JSON.stringify({ box, call, status, usd: microToUsd(microUsd), ...(cached ? { cached } : {}) }))
}

const REGISTRY = '__registry'
const MAX_BODY = 8 * 1024
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_QUOTA = 1000
const GOOGLE_TIMEOUT_MS = 4000

const STATUS_FOR: Record<Unavailable, number> = {
  unauthorized: 401,
  over_quota: 429,
  bad_request: 400,
  not_found: 404,
  upstream: 502,
  timeout: 504,
  not_configured: 503,
}

const BOX_ROUTES: Record<string, MapsCall | 'usage'> = {
  'POST /v1/geocode': 'geocode',
  'POST /v1/route': 'route',
  'POST /v1/places': 'places',
  'GET /v1/usage': 'usage',
}

// --- the Worker ------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const token = bearer(req)
    if (!token) return json({ error: 'unauthorized' }, 401)

    if (url.pathname.startsWith('/v1/admin/')) {
      if (!env.ADMIN_TOKEN_SHA256 || !sameDigest(await sha256Hex(token), env.ADMIN_TOKEN_SHA256)) return json({ error: 'unauthorized' }, 401)
      const admin = /^\/v1\/admin\/boxes\/([^/]+)\/(token|revoke|quota)$/.exec(url.pathname)
      if (admin && req.method === 'POST') {
        const [, box, verb] = admin
        if (!BOX_NAME.test(box)) return json({ error: 'bad box name' }, 400)
        const body = verb === 'quota' ? await req.text() : undefined
        const res = await stub(env, box).fetch(new Request(`https://do/${verb}`, { method: 'POST', headers: { 'x-box': box }, body }))
        if (verb === 'token' && res.ok) await stub(env, REGISTRY).fetch(new Request('https://do/register', { method: 'POST', body: box }))
        return res
      }
      if (url.pathname === '/v1/admin/usage' && req.method === 'GET') {
        const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') ?? '') ? url.searchParams.get('month')! : utcMonth(Date.now())
        const boxes = await registered(env)
        const rows = await Promise.all(boxes.map(async (box) => ({ box, ...((await (await stub(env, box).fetch(new Request(`https://do/report?month=${month}`))).json()) as object) })))
        return json({ month, boxes: rows })
      }
      return json({ error: 'not found' }, 404)
    }

    const dot = token.indexOf('.')
    const box = dot > 0 ? token.slice(0, dot) : ''
    if (!BOX_NAME.test(box)) return json({ error: 'unauthorized' }, 401)
    const call = BOX_ROUTES[`${req.method} ${url.pathname}`]
    if (!call) return json({ error: 'not found' }, 404)
    if (req.method === 'POST' && Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too large' }, 413)
    const body = req.method === 'POST' ? await req.text() : undefined
    if (body !== undefined && body.length > MAX_BODY) return json({ error: 'too large' }, 413)
    return stub(env, box).fetch(new Request(`https://do${url.pathname}`, {
      method: req.method,
      headers: { 'x-box': box, 'x-secret': token.slice(dot + 1) },
      body,
    }))
  },

  /** Daily: drop geocode cache entries past 30 days on every box. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    let dropped = 0
    for (const box of await registered(env)) {
      const res = await stub(env, box).fetch(new Request('https://do/purge', { method: 'POST' }))
      dropped += ((await res.json()) as { dropped: number }).dropped
    }
    console.log(JSON.stringify({ cron: 'purge', dropped }))
  },
}

async function registered(env: Env): Promise<string[]> {
  return (await (await stub(env, REGISTRY).fetch(new Request('https://do/list'))).json()) as string[]
}

function stub(env: Env, name: string): DurableObjectStub {
  return env.MAPS.get(env.MAPS.idFromName(name))
}

// --- one box ---------------------------------------------------------------

export interface MonthUsage {
  /** Requests counted against the quota: every call that went to Google, answered or not. */
  requests: number
  /** Billed cost, micro-dollars. */
  microUsd: number
  calls: Record<MapsCall, number>
  cacheHits: number
  /** Calls refused because the quota was used up. */
  refused: number
}

const emptyUsage = (): MonthUsage => ({ requests: 0, microUsd: 0, calls: { geocode: 0, route: 0, places: 0 }, cacheHits: 0, refused: 0 })

type CacheEntry = { at: number; value: unknown }

export class BoxMaps {
  constructor(private state: DurableObjectState, private env: Env) {}
  /** Test seam. */
  now = () => Date.now()

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const s = this.state.storage

    // Admin-side calls arrive from the Worker itself, already authorised.
    if (url.pathname === '/token') {
      const secret = newSecret()
      await s.put('tokenSha256', await sha256Hex(secret))
      await s.put('issuedAt', new Date(this.now()).toISOString())
      await s.delete('revokedAt')
      return json({ token: `${req.headers.get('x-box') ?? ''}.${secret}` })
    }
    if (url.pathname === '/revoke') {
      await s.delete('tokenSha256')
      await s.put('revokedAt', new Date(this.now()).toISOString())
      return json({ ok: true })
    }
    if (url.pathname === '/quota') {
      const n = Number(((await req.json().catch(() => null)) as { monthlyRequests?: unknown } | null)?.monthlyRequests)
      if (!Number.isInteger(n) || n < 0) return json({ error: 'monthlyRequests must be a whole number' }, 400)
      await s.put('quota', n)
      return json({ quota: n })
    }
    if (url.pathname === '/report') return json(await this.report(url.searchParams.get('month') ?? utcMonth(this.now())))
    if (url.pathname === '/register') {
      const boxes = new Set((await s.get<string[]>('boxes')) ?? [])
      boxes.add(await req.text())
      await s.put('boxes', [...boxes].sort())
      return json({ ok: true })
    }
    if (url.pathname === '/list') return json((await s.get<string[]>('boxes')) ?? [])
    if (url.pathname === '/purge') return json({ dropped: await this.purge() })

    // Box calls: check the box's own token. Unknown, wrong and revoked all look the same.
    const box = req.headers.get('x-box') ?? ''
    const call = url.pathname.slice('/v1/'.length) as MapsCall | 'usage'
    const stored = await s.get<string>('tokenSha256')
    if (!stored || !sameDigest(await sha256Hex(req.headers.get('x-secret') ?? ''), stored)) {
      logLine(box, call, 401, 0)
      return json({ error: 'unauthorized' }, 401)
    }
    if (call === 'usage') return json(await this.report(utcMonth(this.now())))

    const input = await req.json().catch(() => null) as Record<string, unknown> | null
    if (call === 'geocode') {
      const text = cleanText(input?.text)
      if (!text) return this.refuse(box, call, 'bad_request')
      const key = `geo:${await sha256Hex(text.toLowerCase())}`
      const hit = await s.get<CacheEntry>(key)
      if (hit && this.now() - hit.at < CACHE_TTL_MS) {
        await this.state.blockConcurrencyWhile(async () => {
          const u = await this.usage()
          u.cacheHits++
          await this.saveUsage(u)
        })
        logLine(box, call, 200, 0, true)
        return json({ result: hit.value, usd: 0, cached: true })
      }
      if (hit) await s.delete(key)
      return this.viaGoogle(box, call, (o) => googleGeocode(text, o), async (value) => { await s.put(key, { at: this.now(), value }) })
    }
    if (call === 'places') {
      const text = cleanText(input?.text)
      if (!text) return this.refuse(box, call, 'bad_request')
      return this.viaGoogle(box, call, (o) => googlePlaces(text, o))
    }
    const route = cleanRouteRequest(input)
    if (!route) return this.refuse(box, call, 'bad_request')
    return this.viaGoogle(box, call, (o) => googleRoute(route, o))
  }

  private refuse(box: string, call: string, reason: Unavailable, microUsd = 0): Response {
    const status = STATUS_FOR[reason]
    logLine(box, call, status, microUsd)
    return json({ error: reason, usd: microToUsd(microUsd) }, status)
  }

  /** Take a place under the quota, call Google, then record what it billed. */
  private async viaGoogle<T>(box: string, call: MapsCall, run: (o: { key: string; fetch?: typeof fetch; timeoutMs: number; now: () => number }) => Promise<Outcome<T>>, onOk?: (value: T) => Promise<void>): Promise<Response> {
    if (!this.env.GOOGLE_MAPS_API_KEY) return this.refuse(box, call, 'not_configured')
    const allowed = await this.state.blockConcurrencyWhile(async () => {
      const u = await this.usage()
      if (u.requests >= (await this.quota())) {
        u.refused++
        await this.saveUsage(u)
        return false
      }
      u.requests++
      u.calls[call]++
      await this.saveUsage(u)
      return true
    })
    if (!allowed) return this.refuse(box, call, 'over_quota')

    const out = await run({ key: this.env.GOOGLE_MAPS_API_KEY, fetch: this.env.GOOGLE_FETCH, timeoutMs: GOOGLE_TIMEOUT_MS, now: this.now })
    if (out.microUsd > 0) {
      await this.state.blockConcurrencyWhile(async () => {
        const u = await this.usage()
        u.microUsd += out.microUsd
        await this.saveUsage(u)
      })
    }
    if (!out.ok) return this.refuse(box, call, out.reason, out.microUsd)
    if (onOk) await onOk(out.value)
    logLine(box, call, 200, out.microUsd)
    return json({ result: out.value, usd: microToUsd(out.microUsd) })
  }

  private async quota(): Promise<number> {
    const set = await this.state.storage.get<number>('quota')
    if (typeof set === 'number') return set
    const d = Number(this.env.DEFAULT_MONTHLY_REQUESTS)
    return Number.isInteger(d) && d >= 0 ? d : DEFAULT_QUOTA
  }

  private async usage(month = utcMonth(this.now())): Promise<MonthUsage> {
    return (await this.state.storage.get<MonthUsage>(`usage:${month}`)) ?? emptyUsage()
  }

  private saveUsage(u: MonthUsage): Promise<void> {
    return this.state.storage.put(`usage:${utcMonth(this.now())}`, u)
  }

  private async report(month: string) {
    const u = await this.usage(month)
    return {
      month,
      requests: u.requests,
      usd: microToUsd(u.microUsd),
      quota: await this.quota(),
      calls: u.calls,
      cacheHits: u.cacheHits,
      refused: u.refused,
      revoked: (await this.state.storage.get<string>('revokedAt')) ?? null,
    }
  }

  private async purge(): Promise<number> {
    let dropped = 0
    for (const [key, entry] of await this.state.storage.list<CacheEntry>({ prefix: 'geo:' })) {
      if (this.now() - entry.at >= CACHE_TTL_MS) {
        await this.state.storage.delete(key)
        dropped++
      }
    }
    return dropped
  }
}
