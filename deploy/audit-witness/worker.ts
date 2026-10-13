/**
 * havn-audit: the off-box witness for hosted boxes' audit logs (card #196,
 * part 2). A Cloudflare Worker with one Durable Object per box and an R2
 * bucket whose `boxes/` prefix is under a bucket lock, so stored batches
 * cannot be deleted or overwritten for the retention period.
 *
 * Box routes take `Authorization: Bearer <box>.<secret>`:
 *   POST /v1/append        {events: ShippedEvent[]}  -> 200 {head} | 409 {reason, head}
 *   GET  /v1/head                                    -> {head, lastAppendAt}
 *   GET  /v1/events?from=N&limit=M                   -> {events}
 *
 * Admin routes take `Authorization: Bearer <admin token>` (its SHA-256 is the
 * ADMIN_TOKEN_SHA256 secret):
 *   POST /v1/admin/boxes/<box>/token  -> {token}  (replaces any earlier token)
 *   GET  /v1/admin/status             -> {boxes: [{box, head, lastAppendAt, conflicts, lastConflict}]}
 *
 * There is no route that deletes or rewrites anything. Tokens are stored
 * hashed. Deploy and setup: deploy/audit-witness/README.md.
 */
import { BOX_NAME, GENESIS_HASH, batchKey, checkBatch, parseBatchKey, sha256Hex, type Head, type ShippedEvent } from '../../src/assurance/witness-protocol.js'

// --- the slice of the Workers runtime this uses -------------------------------

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
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
interface R2Object { key: string }
interface R2ObjectBody extends R2Object { text(): Promise<string> }
interface R2Bucket {
  put(key: string, value: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<R2ObjectBody | null>
  list(opts: { prefix: string; cursor?: string; startAfter?: string }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>
}

export interface Env {
  WITNESS: DurableObjectNamespace
  BUCKET: R2Bucket
  ADMIN_TOKEN_SHA256: string
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

const REGISTRY = '__registry'
const MAX_BODY = 1024 * 1024

// --- the Worker ------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const token = bearer(req)
    if (!token) return json({ error: 'unauthorized' }, 401)

    if (url.pathname.startsWith('/v1/admin/')) {
      if (!env.ADMIN_TOKEN_SHA256 || !sameDigest(await sha256Hex(token), env.ADMIN_TOKEN_SHA256)) return json({ error: 'unauthorized' }, 401)
      const issue = /^\/v1\/admin\/boxes\/([^/]+)\/token$/.exec(url.pathname)
      if (issue && req.method === 'POST') {
        const box = issue[1]
        if (!BOX_NAME.test(box)) return json({ error: 'bad box name' }, 400)
        const res = await stub(env, box).fetch(new Request('https://do/issue', { method: 'POST', headers: { 'x-box': box } }))
        await stub(env, REGISTRY).fetch(new Request('https://do/register', { method: 'POST', body: box }))
        return res
      }
      if (url.pathname === '/v1/admin/status' && req.method === 'GET') {
        const boxes = (await (await stub(env, REGISTRY).fetch(new Request('https://do/list'))).json()) as string[]
        const status = await Promise.all(boxes.map(async (box) => ({ box, ...(await (await stub(env, box).fetch(new Request('https://do/status'))).json() as object) })))
        return json({ boxes: status })
      }
      return json({ error: 'not found' }, 404)
    }

    const dot = token.indexOf('.')
    const box = dot > 0 ? token.slice(0, dot) : ''
    if (!BOX_NAME.test(box)) return json({ error: 'unauthorized' }, 401)
    const route = `${req.method} ${url.pathname}`
    if (!['POST /v1/append', 'GET /v1/head', 'GET /v1/events'].includes(route)) return json({ error: 'not found' }, 404)
    if (req.method === 'POST' && Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too large' }, 413)
    const fwd = new Request(`https://do${url.pathname}${url.search}`, {
      method: req.method,
      headers: { 'x-box': box, 'x-secret': token.slice(dot + 1) },
      body: req.method === 'POST' ? await req.text() : undefined,
    })
    return stub(env, box).fetch(fwd)
  },
}

function stub(env: Env, name: string): DurableObjectStub {
  return env.WITNESS.get(env.WITNESS.idFromName(name))
}

// --- one box ---------------------------------------------------------------

type Conflict = { at: string; reason: string }

export class BoxWitness {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const s = this.state.storage

    // Admin-side calls arrive from the Worker itself, already authorised.
    if (url.pathname === '/issue') {
      const secret = newSecret()
      await s.put('tokenSha256', await sha256Hex(secret))
      return json({ token: `${req.headers.get('x-box') ?? ''}.${secret}` })
    }
    if (url.pathname === '/register') {
      const boxes = new Set((await s.get<string[]>('boxes')) ?? [])
      boxes.add(await req.text())
      await s.put('boxes', [...boxes].sort())
      return json({ ok: true })
    }
    if (url.pathname === '/list') return json((await s.get<string[]>('boxes')) ?? [])
    if (url.pathname === '/status') {
      return json({
        head: (await s.get<Head>('head')) ?? { seq: 0, hash: GENESIS_HASH },
        lastAppendAt: (await s.get<string>('lastAppendAt')) ?? null,
        conflicts: (await s.get<number>('conflicts')) ?? 0,
        lastConflict: (await s.get<Conflict>('lastConflict')) ?? null,
      })
    }

    // Box calls: check the box's own token.
    const box = req.headers.get('x-box') ?? ''
    const stored = await s.get<string>('tokenSha256')
    if (!stored || !sameDigest(await sha256Hex(req.headers.get('x-secret') ?? ''), stored)) return json({ error: 'unauthorized' }, 401)

    if (url.pathname === '/v1/head') {
      return json({ head: (await s.get<Head>('head')) ?? { seq: 0, hash: GENESIS_HASH }, lastAppendAt: (await s.get<string>('lastAppendAt')) ?? null })
    }
    if (url.pathname === '/v1/events') return this.events(box, url)
    return this.state.blockConcurrencyWhile(() => this.append(box, req))
  }

  private async append(box: string, req: Request): Promise<Response> {
    const s = this.state.storage
    let body: { events?: unknown }
    try {
      body = (await req.json()) as { events?: unknown }
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const head = (await s.get<Head>('head')) ?? { seq: 0, hash: GENESIS_HASH }
    const check = checkBatch(head, body.events)
    if (!check.ok) {
      if (check.status === 409) {
        await s.put('conflicts', ((await s.get<number>('conflicts')) ?? 0) + 1)
        await s.put('lastConflict', { at: new Date().toISOString(), reason: check.reason })
      }
      return json({ error: check.reason, head }, check.status)
    }
    const events = body.events as ShippedEvent[]
    const key = batchKey(box, events[0].seq, events[events.length - 1].seq)
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    try {
      await this.env.BUCKET.put(key, text, { httpMetadata: { contentType: 'application/x-ndjson' } })
    } catch (err) {
      // A retry after a lost acknowledgement hits the bucket lock on an
      // identical object. Same bytes: the batch is stored, carry on.
      const existing = await this.env.BUCKET.get(key)
      if (!existing || (await existing.text()) !== text) return json({ error: `store failed: ${String(err)}` }, 503)
    }
    await s.put('head', check.head)
    await s.put('lastAppendAt', new Date().toISOString())
    return json({ head: check.head })
  }

  private async events(box: string, url: URL): Promise<Response> {
    const from = Math.max(1, Number(url.searchParams.get('from') ?? 1) || 1)
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 1000) || 1000))
    const out: ShippedEvent[] = []
    let next = from
    let cursor: string | undefined
    do {
      const page = await this.env.BUCKET.list({ prefix: `boxes/${box}/`, cursor })
      for (const obj of page.objects) {
        const range = parseBatchKey(obj.key)
        if (!range || range.to < next) continue
        const body = await this.env.BUCKET.get(obj.key)
        if (!body) continue
        for (const line of (await body.text()).split('\n')) {
          if (!line) continue
          const e = JSON.parse(line) as ShippedEvent
          // Overlapping batches (a retry that grew) repeat seqs; keep the first.
          if (e.seq !== next) continue
          out.push(e)
          next++
          if (out.length >= limit) return json({ events: out })
        }
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return json({ events: out })
  }
}
