/**
 * The anonymizer's local proxy for the Claude CLI (card #187).
 *
 * The CLI talks to Anthropic over HTTP, out of reach of this process. When a
 * run is private, its CLI gets ANTHROPIC_BASE_URL pointing here instead:
 * http://127.0.0.1:<port>/p/<token>. This server masks each Messages request,
 * forwards it to the real API, and restores the reply on the way back. Every
 * other path (token counting aside) passes through unchanged.
 *
 * It listens on loopback only. The token in the path is made per run and
 * dropped when the run ends; a request without a live token is refused, so
 * nothing else on the machine can use it as a relay.
 *
 * Fails closed: a Messages request that cannot be masked is refused with an
 * error, never sent as it is.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { logger } from '../logger.js'
import { maskRequest, requestTexts, restoreResponse, SseRestorer, type MessagesBody } from './anthropic.js'
import { maskerFor } from './store.js'
import { PrivacyRefusal, type MaskScope } from './mask.js'

export const DEFAULT_UPSTREAM = 'https://api.anthropic.com'

type Route = { upstream: string; hits: number }

const routes = new Map<string, Route>()
let server: Server | null = null
let starting: Promise<number> | null = null
let port = 0

/** The paths whose bodies are masked: a Messages call and its token count. */
const MESSAGES = /\/v1\/messages(?:\/count_tokens)?$/

// Hop-by-hop headers, plus the ones this proxy sets itself.
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'proxy-connection'])
const DROP_RES = new Set(['connection', 'content-length', 'content-encoding', 'transfer-encoding', 'keep-alive'])

/** Start the proxy if it is not running. Resolves to its port. */
export function ensurePrivacyProxy(): Promise<number> {
  if (server && port) return Promise.resolve(port)
  if (starting) return starting
  starting = new Promise<number>((resolve, reject) => {
    const s = createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (res.destroyed) return
        logger.error({ err: String(err) }, 'privacy proxy: request failed')
        // Mid-stream, an error body would corrupt the reply: cut it off instead.
        if (res.headersSent) return void res.destroy()
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'The privacy filter could not complete this request.' } }))
      })
    })
    s.on('error', (err) => {
      starting = null
      reject(err)
    })
    s.listen(0, '127.0.0.1', () => {
      server = s
      port = (s.address() as AddressInfo).port
      starting = null
      resolve(port)
    })
  })
  return starting
}

/** Stop the proxy (tests). */
export async function stopPrivacyProxy(): Promise<void> {
  const s = server
  server = null
  port = 0
  routes.clear()
  if (s) await new Promise<void>((r) => s.close(() => r()))
}

/** The proxy's address for the egress allow list, or null while it is not running. */
export function privacyProxyAddress(): string | null {
  return server && port ? `127.0.0.1:${port}` : null
}

/** A base URL for one run's CLI, sending its calls on to `upstream`. Call the returned drop() when the run ends. */
export async function openRoute(upstream: string = DEFAULT_UPSTREAM): Promise<{ baseUrl: string; drop: () => void; hits: () => number }> {
  const p = await ensurePrivacyProxy()
  const token = randomBytes(18).toString('base64url')
  const route: Route = { upstream: upstream.replace(/\/+$/, ''), hits: 0 }
  routes.set(token, route)
  return { baseUrl: `http://127.0.0.1:${p}/p/${token}`, drop: () => routes.delete(token), hits: () => route.hits }
}

function maskAll(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => maskAll(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [f(k), maskAll(x, f)]))
  return v
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); collectStrings(x, out) }
  return out
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = /^\/p\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(req.url ?? '')
  const route = m ? routes.get(m[1]) : undefined
  if (!m || !route) return refuse(res, 404, 'Unknown route.')
  const rest = m[2] ?? '/'
  const pathOnly = rest.split('?')[0]
  const masked = req.method === 'POST' && MESSAGES.test(pathOnly)

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_REQ.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }
  headers['accept-encoding'] = 'identity'

  let body: Buffer | undefined = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
  // Any other request with a body: every string in it masked if it is JSON,
  // refused if it is not. Nothing reaches the API unread.
  if (!masked && body && body.length) {
    let other: unknown
    try {
      other = JSON.parse(body.toString('utf8'))
    } catch {
      return refuse(res, 403, 'The privacy filter only passes on requests it can read.')
    }
    const scope = maskerFor(collectStrings(other)).scope()
    body = Buffer.from(JSON.stringify(maskAll(other, (s) => scope.mask(s))), 'utf8')
  }
  let masker: MaskScope | null = null
  if (masked) route.hits++
  if (masked) {
    let parsed: MessagesBody
    try {
      parsed = JSON.parse(body!.toString('utf8')) as MessagesBody
    } catch {
      return refuse(res, 400, 'The privacy filter could not read this request, so it was not sent.')
    }
    masker = maskerFor(requestTexts(parsed)).scope()
    try {
      body = Buffer.from(JSON.stringify(maskRequest(parsed, masker)), 'utf8')
    } catch (err) {
      if (err instanceof PrivacyRefusal) return refuse(res, 400, err.message)
      throw err
    }
  }

  // The CLI gone (a cancelled turn): stop the upstream call too, so the AI
  // does not keep writing, and billing, a reply nobody reads.
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  const upstream = await fetch(`${route.upstream}${rest}`, {
    signal: abort.signal,
    method: req.method,
    headers,
    ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
    redirect: 'manual',
  })

  const outHeaders: Record<string, string> = {}
  upstream.headers.forEach((v, k) => {
    if (!DROP_RES.has(k.toLowerCase())) outHeaders[k] = v
  })
  const type = upstream.headers.get('content-type') ?? ''

  if (!masker || !upstream.body || pathOnly.endsWith('/count_tokens')) {
    res.writeHead(upstream.status, outHeaders)
    if (upstream.body) for await (const c of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(c)
    res.end()
    return
  }

  if (type.includes('text/event-stream')) {
    res.writeHead(upstream.status, outHeaders)
    const sse = new SseRestorer(masker)
    const decoder = new TextDecoder()
    for await (const c of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      const out = sse.feed(decoder.decode(c, { stream: true }))
      if (out) res.write(out)
    }
    const tail = sse.feed(decoder.decode()) + sse.end()
    res.end(tail)
    return
  }

  const text = await upstream.text()
  let out = text
  if (type.includes('json')) {
    try {
      out = JSON.stringify(restoreResponse(JSON.parse(text) as MessagesBody, masker))
    } catch {
      /* not a JSON body after all: pass it on */
    }
  }
  res.writeHead(upstream.status, outHeaders)
  res.end(out)
}
