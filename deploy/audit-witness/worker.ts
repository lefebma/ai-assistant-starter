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
 *   POST /v1/check         {ok, problems, full}      -> {ok}  (the box's own check, hourly)
 *
 * Admin routes take `Authorization: Bearer <admin token>` (its SHA-256 is the
 * ADMIN_TOKEN_SHA256 secret):
 *   POST /v1/admin/boxes/<box>/token   -> {token}  (replaces any earlier token)
 *   POST /v1/admin/boxes/<box>/ack     -> {conflictsAcked}  (conflicts looked at)
 *   POST /v1/admin/boxes/<box>/retire  -> {ok}  (stop watching; nothing is deleted)
 *   GET  /v1/admin/status              -> {boxes: [BoxStatus & {problems}]}
 *
 * A daily cron (part 3) runs boxProblems over every box and, when the
 * ALERT_TELEGRAM_TOKEN and ALERT_TELEGRAM_CHAT secrets are set, sends the
 * operator one message listing what is wrong. Without them it only logs.
 *
 * There is no route that deletes or rewrites anything. Tokens are stored
 * hashed. Deploy and setup: deploy/audit-witness/README.md.
 */
import { BOX_NAME, GENESIS_HASH, batchKey, boxProblems, checkBatch, parseBatchKey, parseCheckReport, sha256Hex, type BoxStatus, type Head, type ShippedEvent } from '../../src/assurance/witness-protocol.js'

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
  ALERT_TELEGRAM_TOKEN?: string
  ALERT_TELEGRAM_CHAT?: string
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
      const admin = /^\/v1\/admin\/boxes\/([^/]+)\/(token|ack|retire)$/.exec(url.pathname)
      if (admin && req.method === 'POST') {
        const [, box, verb] = admin
        if (!BOX_NAME.test(box)) return json({ error: 'bad box name' }, 400)
        if (verb === 'retire') return stub(env, REGISTRY).fetch(new Request('https://do/unregister', { method: 'POST', body: box }))
        if (verb === 'ack') return stub(env, box).fetch(new Request('https://do/ack', { method: 'POST' }))
        const res = await stub(env, box).fetch(new Request('https://do/issue', { method: 'POST', headers: { 'x-box': box } }))
        await stub(env, REGISTRY).fetch(new Request('https://do/register', { method: 'POST', body: box }))
        return res
      }
      if (url.pathname === '/v1/admin/status' && req.method === 'GET') {
        const now = Date.now()
        return json({ boxes: (await allStatus(env)).map((s) => ({ ...s, problems: boxProblems(s, now) })) })
      }
      return json({ error: 'not found' }, 404)
    }

    const dot = token.indexOf('.')
    const box = dot > 0 ? token.slice(0, dot) : ''
    if (!BOX_NAME.test(box)) return json({ error: 'unauthorized' }, 401)
    const route = `${req.method} ${url.pathname}`
    if (!['POST /v1/append', 'GET /v1/head', 'GET /v1/events', 'POST /v1/check'].includes(route)) return json({ error: 'not found' }, 404)
    if (req.method === 'POST' && Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too large' }, 413)
    const fwd = new Request(`https://do${url.pathname}${url.search}`, {
      method: req.method,
      headers: { 'x-box': box, 'x-secret': token.slice(dot + 1) },
      body: req.method === 'POST' ? await req.text() : undefined,
    })
    return stub(env, box).fetch(fwd)
  },

  /** Daily: tell the operator about every box with a problem. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const report = await dailyReport(env, Date.now())
    if (!report) return
    console.log(report)
    if (!env.ALERT_TELEGRAM_TOKEN || !env.ALERT_TELEGRAM_CHAT) return
    const res = await fetch(`https://api.telegram.org/bot${env.ALERT_TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.ALERT_TELEGRAM_CHAT, text: report }),
    })
    if (!res.ok) console.log(`alert send failed: ${res.status}`)
  },
}

export async function allStatus(env: Env): Promise<BoxStatus[]> {
  const boxes = (await (await stub(env, REGISTRY).fetch(new Request('https://do/list'))).json()) as string[]
  return Promise.all(boxes.map(async (box) => ({ box, ...((await (await stub(env, box).fetch(new Request('https://do/status'))).json()) as Omit<BoxStatus, 'box'>) })))
}

/** The operator's daily message, or null when every box is fine. */
export async function dailyReport(env: Env, now: number): Promise<string | null> {
  const lines = (await allStatus(env)).flatMap((s) => boxProblems(s, now).map((p) => `- ${s.box}: ${p}`))
  return lines.length ? `Audit witness: ${lines.length} problem(s)\n${lines.join('\n')}` : null
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
      await s.put('issuedAt', new Date().toISOString())
      return json({ token: `${req.headers.get('x-box') ?? ''}.${secret}` })
    }
    if (url.pathname === '/register') {
      const boxes = new Set((await s.get<string[]>('boxes')) ?? [])
      boxes.add(await req.text())
      await s.put('boxes', [...boxes].sort())
      return json({ ok: true })
    }
    if (url.pathname === '/unregister') {
      const name = await req.text()
      await s.put('boxes', ((await s.get<string[]>('boxes')) ?? []).filter((b) => b !== name))
      return json({ ok: true })
    }
    if (url.pathname === '/list') return json((await s.get<string[]>('boxes')) ?? [])
    if (url.pathname === '/ack') {
      const conflicts = (await s.get<number>('conflicts')) ?? 0
      await s.put('conflictsAcked', conflicts)
      return json({ conflictsAcked: conflicts })
    }
    if (url.pathname === '/status') {
      const status: Omit<BoxStatus, 'box'> = {
        head: (await s.get<Head>('head')) ?? { seq: 0, hash: GENESIS_HASH },
        issuedAt: (await s.get<string>('issuedAt')) ?? null,
        lastAppendAt: (await s.get<string>('lastAppendAt')) ?? null,
        conflicts: (await s.get<number>('conflicts')) ?? 0,
        conflictsAcked: (await s.get<number>('conflictsAcked')) ?? 0,
        lastConflict: (await s.get<Conflict>('lastConflict')) ?? null,
        lastCheck: (await s.get<BoxStatus['lastCheck']>('lastCheck')) ?? null,
        lastFullCheckAt: (await s.get<string>('lastFullCheckAt')) ?? null,
      }
      return json(status)
    }

    // Box calls: check the box's own token.
    const box = req.headers.get('x-box') ?? ''
    const stored = await s.get<string>('tokenSha256')
    if (!stored || !sameDigest(await sha256Hex(req.headers.get('x-secret') ?? ''), stored)) return json({ error: 'unauthorized' }, 401)

    if (url.pathname === '/v1/head') {
      return json({ head: (await s.get<Head>('head')) ?? { seq: 0, hash: GENESIS_HASH }, lastAppendAt: (await s.get<string>('lastAppendAt')) ?? null })
    }
    if (url.pathname === '/v1/events') return this.events(box, url)
    if (url.pathname === '/v1/check') return this.check(req)
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

  /** The box's own check, kinds only. Doubles as its hourly heartbeat. */
  private async check(req: Request): Promise<Response> {
    const report = parseCheckReport(await req.json().catch(() => null))
    if (!report) return json({ error: 'bad report' }, 400)
    const at = new Date().toISOString()
    await this.state.storage.put('lastCheck', { at, ok: report.ok, problems: report.problems })
    if (report.full) await this.state.storage.put('lastFullCheckAt', at)
    return json({ ok: true })
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
