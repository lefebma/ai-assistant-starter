/**
 * havn-connect: the sign-in relay at connect.gethavn.ai (card #206). A
 * Cloudflare Worker wrapping createRelay (src/connect/relay.ts), with one
 * Durable Object that holds two things:
 *
 *  - The keys of used sign-in states, so a link works once across every copy
 *    of the Worker, not just the one that saw it first. A key is kept only
 *    until its state would have expired anyway, and an expiry index lets each
 *    check clear a bounded batch instead of reading every key.
 *  - The box registry: for each box id, the https origin hand-offs go to, the
 *    hand-off key that signs them, and the name shown to the person signing
 *    in. The relay mints the key; the operator copies it to the box once.
 *
 * No token is ever stored here. Google's client secret and the sealing secret
 * are Worker secrets; Microsoft needs none (public client with PKCE). Every
 * public route is rate limited per client address when the RATE_LIMITER
 * binding exists.
 *
 * Public routes (from createRelay): GET /start (confirmation page), POST /start
 * (its button), GET /callback, and POST /refresh and /revoke (Gmail, signed
 * with the box's hand-off key).
 * Admin routes take `Authorization: Bearer <admin token>` (its SHA-256 is the
 * ADMIN_TOKEN_SHA256 secret):
 *   POST   /admin/boxes/<box>  {origin, label}  -> {box, origin, label, handoffKey}  (replaces any earlier key)
 *   DELETE /admin/boxes/<box>                   -> {ok}
 *   GET    /admin/boxes                         -> {boxes: [{box, origin, label, registeredAt}]}  (never the keys)
 *
 * Deploy and setup: deploy/connect-relay/README.md.
 */
import { createRelay, type BoxRecord, type RelayProvider } from '../../src/connect/relay.js'
import { googleProvider, microsoftProvider } from '../../src/connect/providers.js'
import type { UsedStore } from '../../src/connect/state.js'

// --- the slice of the Workers runtime this uses -------------------------------

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(opts: { prefix: string; end?: string; limit?: number }): Promise<Map<string, T>>
}
interface DurableObjectState {
  storage: DurableObjectStorage
}
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface RateLimit { limit(opts: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  STORE: DurableObjectNamespace
  RATE_LIMITER?: RateLimit
  PUBLIC_URL: string
  SIGNING_SECRET: string
  SEALING_SECRET: string
  ADMIN_TOKEN_SHA256: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  MS_CLIENT_ID?: string
}

// --- helpers ---------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const BOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function newKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** An https origin and nothing else: no path, query, credentials or fragment. */
export function cleanOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
    return u.origin
  } catch {
    return null
  }
}

const store = (env: Env) => env.STORE.get(env.STORE.idFromName('main'))
const ask = (env: Env, path: string, body?: unknown) =>
  store(env).fetch(new Request(`https://do${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }))

interface StoredBox extends BoxRecord { label: string; registeredAt: string }

/** Expired keys cleared per check: enough to outpace any rate the limiter lets through. */
export const PRUNE_BATCH = 50
const expKey = (exp: number, key: string) => `exp:${String(Math.max(0, Math.floor(exp))).padStart(15, '0')}:${key}`

/** A display name: 1 to 60 characters, none of them markup or control characters. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return s.length >= 1 && s.length <= 60 && !/[<>"&\u0000-\u001f]/.test(s) ? s : null
}

// --- the Durable Object ------------------------------------------------------

export class RelayStore {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const s = this.state.storage
    const path = new URL(req.url).pathname
    const body = req.body ? ((await req.json()) as Record<string, unknown>) : {}

    // A Durable Object runs one event at a time and its input gate holds new
    // events while storage calls are pending, so this read-then-write is atomic.
    if (path === '/used') {
      const id = String(body.key)
      const now = Number(body.now)
      const exp = Number(body.expiresAt)
      for (const [k, usedKey] of await s.list<string>({ prefix: 'exp:', end: expKey(now, ''), limit: PRUNE_BATCH })) {
        await s.delete(k)
        await s.delete(usedKey)
      }
      const usedKey = `used:${id}`
      const seen = await s.get<number>(usedKey)
      if (seen !== undefined && seen >= now) return json({ fresh: false })
      await s.put(usedKey, exp)
      await s.put(expKey(exp, id), usedKey)
      return json({ fresh: true })
    }
    if (path === '/box/get') return json((await s.get<StoredBox>(`box:${String(body.box)}`)) ?? null)
    if (path === '/box/put') {
      const rec: StoredBox = { origin: String(body.origin), label: String(body.label), handoffKey: newKey(), registeredAt: new Date().toISOString() }
      await s.put(`box:${String(body.box)}`, rec)
      return json({ box: body.box, origin: rec.origin, label: rec.label, handoffKey: rec.handoffKey })
    }
    if (path === '/box/delete') return json({ ok: await s.delete(`box:${String(body.box)}`) })
    if (path === '/box/list') {
      const boxes = [...(await s.list<StoredBox>({ prefix: 'box:' }))].map(([k, v]) => ({ box: k.slice(4), origin: v.origin, label: v.label, registeredAt: v.registeredAt }))
      return json({ boxes })
    }
    return json({ error: 'not found' }, 404)
  }
}

export function durableUsedStore(env: Env): UsedStore {
  return {
    async markUsed(key, expiresAt, now) {
      const r = await ask(env, '/used', { key, expiresAt, now })
      if (!r.ok) throw new Error(`used store ${r.status}`)
      return ((await r.json()) as { fresh: boolean }).fresh
    },
  }
}

/** Only the providers whose app is configured; the others answer /start with "not valid". */
export function providersFrom(env: Env): Record<string, RelayProvider> {
  const out: Record<string, RelayProvider> = {}
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.gmail = googleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET })
  if (env.MS_CLIENT_ID) out.outlook = microsoftProvider(env.MS_CLIENT_ID)
  return out
}

// --- the Worker ----------------------------------------------------------------

async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
  if (!m || !env.ADMIN_TOKEN_SHA256 || !sameDigest(await sha256Hex(m[1]), env.ADMIN_TOKEN_SHA256)) return json({ error: 'unauthorized' }, 401)
  if (url.pathname === '/admin/boxes' && req.method === 'GET') return ask(env, '/box/list')
  const one = /^\/admin\/boxes\/([^/]+)$/.exec(url.pathname)
  if (!one) return json({ error: 'not found' }, 404)
  const box = one[1]
  if (!BOX_ID.test(box)) return json({ error: 'bad box id' }, 400)
  if (req.method === 'DELETE') return ask(env, '/box/delete', { box })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  let b: { origin?: unknown; label?: unknown } = {}
  try {
    b = (await req.json()) as typeof b
  } catch {
    /* fall through */
  }
  const origin = cleanOrigin(b.origin)
  if (!origin) return json({ error: 'origin must be a bare https origin, e.g. https://box.example.com' }, 400)
  const label = cleanLabel(b.label)
  if (!label) return json({ error: 'label must be 1 to 60 characters with no < > " &, e.g. Sam\'s assistant' }, 400)
  return ask(env, '/box/put', { box, origin, label })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/admin/')) return admin(req, env, url)
    if (env.RATE_LIMITER) {
      const who = req.headers.get('cf-connecting-ip') ?? 'unknown'
      const { success } = await env.RATE_LIMITER.limit({ key: `${who}:${url.pathname}` })
      if (!success) return new Response('Too many requests. Wait a minute and try again.', { status: 429, headers: { 'retry-after': '60' } })
    }
    const relay = createRelay({
      publicUrl: env.PUBLIC_URL,
      signingSecret: env.SIGNING_SECRET,
      sealingSecret: env.SEALING_SECRET,
      boxes: {
        async get(id) {
          if (!BOX_ID.test(id)) return undefined
          const r = await ask(env, '/box/get', { box: id })
          return ((await r.json()) as StoredBox | null) ?? undefined
        },
      },
      providers: providersFrom(env),
      used: durableUsedStore(env),
      log: (entry) => console.log(JSON.stringify(entry)),
    })
    return relay.handle(req)
  },
}
