/**
 * Response helpers for the web app routes: security headers, JSON in and out,
 * and a small server-sent-events writer. Later tasks import these rather than
 * writing headers by hand, so the browser hardening stays in one place.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const MAX_JSON_BYTES = 256 * 1024

/** Set on every response the web layer produces, success or error. */
export function applySecurityHeaders(res: ServerResponse, opts: { api: boolean }): void {
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  if (opts.api) res.setHeader('Cache-Control', 'no-store')
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, status: number, code: string, headers: Record<string, string | string[]> = {}): void {
  sendJson(res, status, { error: code }, headers)
}

/** True when the request declares a JSON body. Parameters such as charset are allowed. */
export function requireJson(req: IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return ct === 'application/json'
}

export class BodyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

/** Read and parse a JSON body, refusing anything over `max` bytes (default 256 KB). Throws BodyError. */
export function readJsonCapped(req: IncomingMessage, max: number = MAX_JSON_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      reject(new BodyError(413, 'too_large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > max) {
        done = true
        reject(new BodyError(413, 'too_large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BodyError(400, 'bad_json'))
      }
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

export interface SseStream {
  /** Write one named event. `data` is JSON-encoded. No-op after the client has gone. */
  writeEvent(name: string, data: unknown): void
  startHeartbeat(intervalMs?: number): void
  stopHeartbeat(): void
  /** Stop the heartbeat and end the response. */
  close(): void
  readonly closed: boolean
  /** Runs once when the client disconnects or close() is called. */
  onClose(cb: () => void): void
}

/**
 * Begin a server-sent-events response. A closed browser connection does not
 * throw: `closed` flips, further writes are dropped, and callers decide
 * whether the work behind the stream carries on.
 */
export function openSse(res: ServerResponse, opts: { heartbeatMs?: number } = {}): SseStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  let closed = false
  let timer: NodeJS.Timeout | undefined
  const listeners: Array<() => void> = []

  const markClosed = (): void => {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    timer = undefined
    for (const cb of listeners.splice(0)) {
      try {
        cb()
      } catch {
        // a listener must not break the others
      }
    }
  }
  res.on('close', markClosed)

  const write = (chunk: string): void => {
    if (closed || res.writableEnded || res.destroyed) return
    try {
      res.write(chunk)
    } catch {
      markClosed()
    }
  }

  const stream: SseStream = {
    writeEvent(name, data) {
      const safeName = name.replace(/[\r\n]/g, '')
      write(`event: ${safeName}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    startHeartbeat(intervalMs = 15_000) {
      if (timer || closed) return
      timer = setInterval(() => write(': ping\n\n'), intervalMs)
      timer.unref?.()
    },
    stopHeartbeat() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    close() {
      if (!closed && !res.writableEnded) res.end()
      markClosed()
    },
    get closed() {
      return closed
    },
    onClose(cb) {
      if (closed) cb()
      else listeners.push(cb)
    },
  }
  if (opts.heartbeatMs !== 0) stream.startHeartbeat(opts.heartbeatMs)
  return stream
}
