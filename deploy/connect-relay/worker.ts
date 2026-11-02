/**
 * havn-connect: the sign-in relay at connect.gethavn.ai (card #206). A
 * Cloudflare Worker wrapping createRelay (src/connect/relay.ts), with one
 * Durable Object that holds two things:
 *
 *  - The keys of used sign-in states, so a link works once across every copy
 *    of the Worker, not just the one that saw it first. A key is kept only
 *    until its state would have expired anyway.
 *  - The box registry: for each box id, the https origin hand-offs go to and
 *    the hand-off key that signs them. The relay mints the key; the operator
 *    copies it to the box once.
 *
 * No token is ever stored here. Google's client secret is a Worker secret;
 * Microsoft needs none (public client with PKCE).
 *
 * Public routes (from createRelay): GET /start, GET /callback.
 * Admin routes take `Authorization: Bearer <admin token>` (its SHA-256 is the
 * ADMIN_TOKEN_SHA256 secret):
 *   POST   /admin/boxes/<box>  {origin}  -> {box, origin, handoffKey}  (replaces any earlier key)
 *   DELETE /admin/boxes/<box>            -> {ok}
 *   GET    /admin/boxes                  -> {boxes: [{box, origin, registeredAt}]}  (never the keys)
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
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>
}
interface DurableObjectState {
  storage: DurableObjectStorage
}
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

export interface Env {
  STORE: DurableObjectNamespace
  PUBLIC_URL: string
  SIGNING_SECRET: string
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

interface StoredBox extends BoxRecord { registeredAt: string }

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
      const key = `used:${String(body.key)}`
      const now = Number(body.now)
      for (const [k, exp] of await s.list<number>({ prefix: 'used:' })) if (exp < now) await s.delete(k)
      if ((await s.get<number>(key)) !== undefined) return json({ fresh: false })
      await s.put(key, Number(body.expiresAt))
      return json({ fresh: true })
    }
    if (path === '/box/get') return json((await s.get<StoredBox>(`box:${String(body.box)}`)) ?? null)
    if (path === '/box/put') {
      const rec: StoredBox = { origin: String(body.origin), handoffKey: newKey(), registeredAt: new Date().toISOString() }
      await s.put(`box:${String(body.box)}`, rec)
      return json({ box: body.box, origin: rec.origin, handoffKey: rec.handoffKey })
    }
    if (path === '/box/delete') return json({ ok: await s.delete(`box:${String(body.box)}`) })
    if (path === '/box/list') {
      const boxes = [...(await s.list<StoredBox>({ prefix: 'box:' }))].map(([k, v]) => ({ box: k.slice(4), origin: v.origin, registeredAt: v.registeredAt }))
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
  let origin: string | null = null
  try {
    origin = cleanOrigin(((await req.json()) as { origin?: unknown }).origin)
  } catch {
    /* fall through */
  }
  if (!origin) return json({ error: 'origin must be a bare https origin, e.g. https://box.example.com' }, 400)
  return ask(env, '/box/put', { box, origin })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/admin/')) return admin(req, env, url)
    const relay = createRelay({
      publicUrl: env.PUBLIC_URL,
      signingSecret: env.SIGNING_SECRET,
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
