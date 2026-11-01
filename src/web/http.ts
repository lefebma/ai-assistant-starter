/**
 * Request dispatcher for the web app: `/app`, `/app/*` and `/api/web/*`.
 *
 * Security boundary. `handleWebRequest` is called first thing in the HTTP
 * server's request handler, before CORS and before every other route, so
 * nothing else (the box bearer token, voice cookies, open-loopback mode, the
 * permissive localhost CORS) can touch these paths. Every API route except the
 * link exchange needs a `havn_web` session AND a chat that is still allowed.
 *
 * Import note: this module imports isChatAllowed from bot.ts. http-server.ts
 * already imports bot.ts, so this adds no new cycle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { PROJECT_ROOT, PRIMARY_CHAT_ID, LIVE_VOICE } from '../config.js'
import { logger } from '../logger.js'
import { isChatAllowed } from '../bot.js'
import { assistantName } from '../shortcut-setup.js'
import { dictationDeps } from './dictation.js'
import { voiceChatAvailable } from './voice-chat.js'
import { LIVE_VOICES } from '../voice-live.js'
import {
  SESSION_TTL_MS,
  exchangeWebLink,
  resolveWebSession,
  listWebSessions,
  revokeWebSession,
  revokeOtherWebSessions,
  revokeAllWebSessions,
  webSessionCookie,
  clearWebCookie,
  webSessionFromCookies,
} from './sessions.js'
import {
  applySecurityHeaders,
  sendJson,
  sendError,
  requireJson,
  readJsonCapped,
  BodyError,
} from './respond.js'

export interface WebContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  /** Capture groups of the route pattern, URL-decoded. */
  params: string[]
  /** Real chat id from the session. Empty string on unauthenticated routes. */
  chatId: string
  /** Hash of the caller's session id. Empty string on unauthenticated routes. */
  sessionIdHash: string
  /** Whether the browser reached us over TLS (decides the cookie Secure flag). */
  secure: boolean
}

export interface WebRoute {
  method: string
  /** Matched against the raw path (before decoding), anchored by the dispatcher. */
  pattern: RegExp
  /** true: needs a valid session and an allowed chat. false: open (the exchange route only, today). */
  auth: boolean
  /** Upload routes skip the JSON content-type rule and need `X-Havn-Web: 1` instead. */
  upload?: boolean
  handler(ctx: WebContext): void | Promise<void>
}

const routes: WebRoute[] = []

/** Add routes. Later registrations are consulted after earlier ones. Returns an unregister function. */
export function registerWebRoutes(add: WebRoute[]): () => void {
  routes.push(...add)
  return () => {
    for (const r of add) {
      const i = routes.indexOf(r)
      if (i >= 0) routes.splice(i, 1)
    }
  }
}

// ---------- rate limit (exchange route) ----------

const ATTEMPT_WINDOW_MS = 10 * 60_000
const ATTEMPT_MAX = 10
const MAX_TRACKED_IPS = 5000
const attempts = new Map<string, number[]>()

/** Records an attempt and says whether it is allowed: 10 per IP per 10 minutes. */
export function allowAttempt(ip: string, now: number = Date.now()): boolean {
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
  if (recent.length >= ATTEMPT_MAX) {
    attempts.set(ip, recent)
    return false
  }
  recent.push(now)
  attempts.set(ip, recent)
  if (attempts.size > MAX_TRACKED_IPS) {
    for (const [k, v] of attempts) {
      if (!v.some((t) => now - t < ATTEMPT_WINDOW_MS)) attempts.delete(k)
    }
    // Still over: drop the oldest keys rather than grow without bound.
    while (attempts.size > MAX_TRACKED_IPS) {
      const first = attempts.keys().next().value
      if (first === undefined) break
      attempts.delete(first)
    }
  }
  return true
}

/** Test hook. */
export function resetAttempts(): void {
  attempts.clear()
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * The caller's address for rate limiting. Behind the local edge the socket is
 * loopback and Caddy appends the real client to X-Forwarded-For, so the LAST
 * entry is the one the edge vouches for (earlier ones are client-supplied).
 * Reached directly, the socket address is used and the header is ignored.
 */
function clientIp(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress ?? 'unknown'
  if (isLoopback(addr)) {
    const xff = String(req.headers['x-forwarded-for'] ?? '')
    const last = xff.split(',').pop()?.trim()
    if (last) return last
  }
  return addr
}

/** Mirrors overTls() in http-server.ts: the edge sets X-Forwarded-Proto. */
function overTls(req: IncomingMessage): boolean {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase()
  if (forwarded) return forwarded === 'https'
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

// ---------- page serving ----------

const APP_DIR = resolve(PROJECT_ROOT, 'public', 'app')

const PAGE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

function notFound(res: ServerResponse): void {
  if (res.headersSent) return
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

/** Resolve a request path under /app to a file inside public/app, or null. */
function resolveAppFile(rawPath: string): string | null {
  let rel = rawPath.slice('/app'.length)
  if (rel === '' || rel === '/') return resolve(APP_DIR, 'index.html')
  if (!rel.startsWith('/')) return null
  rel = rel.slice(1)
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/')
  // No empty, dot or dot-dot segments, no hidden files, plain characters only.
  if (!segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) return null
  if (!(extname(decoded).toLowerCase() in PAGE_MIME)) return null
  const full = resolve(APP_DIR, ...segments)
  if (!full.startsWith(APP_DIR + sep)) return null
  if (!existsSync(full)) return null
  try {
    // A symlink inside public/app must not lead outside it.
    const real = realpathSync(full)
    const realBase = realpathSync(APP_DIR)
    if (!real.startsWith(realBase + sep)) return null
    if (!statSync(real).isFile()) return null
    return real
  } catch {
    return null
  }
}

function servePage(req: IncomingMessage, res: ServerResponse, rawPath: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return
  }
  const file = resolveAppFile(rawPath)
  if (!file) return notFound(res)
  let body: Buffer
  try {
    body = readFileSync(file)
  } catch {
    return notFound(res)
  }
  res.writeHead(200, {
    'Content-Type': PAGE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// ---------- dispatcher ----------

export function isWebPath(raw: string): boolean {
  // Case-insensitive: on a case-insensitive disk (macOS) the general static
  // router would otherwise serve /APP/index.html without this layer's headers.
  const p = raw.toLowerCase()
  return p === '/app' || p.startsWith('/app/') || p.startsWith('/api/web/') || p === '/api/web'
}

/**
 * The path the web layer routes on, or null when the request is not for it.
 * The raw path wins when it is a web path. Otherwise the normalised
 * `url.pathname` is checked too: the general router serves files by pathname,
 * so `/./app/index.html` must not slip past this layer's headers to reach it.
 */
export function webPathFor(rawUrl: string | undefined, pathname: string): string | null {
  const raw = (rawUrl ?? '').split('?')[0]!.split('#')[0]!
  if (isWebPath(raw)) return raw
  if (isWebPath(pathname)) return pathname
  return null
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (!host || Array.isArray(origin)) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** True when the request was handled (the caller must stop). */
export async function handleWebRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const rawPath = webPathFor(req.url, url.pathname)
  if (rawPath === null) return false

  const api = rawPath.startsWith('/api/web')
  applySecurityHeaders(res, { api })

  try {
    if (!api) {
      servePage(req, res, rawPath)
      return true
    }

    // Browser-origin checks apply to every API request, before routing.
    if (!originAllowed(req)) return sendError(res, 403, 'bad_origin'), true
    const site = req.headers['sec-fetch-site']
    if (site === 'cross-site') return sendError(res, 403, 'bad_origin'), true

    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      // No CORS for the web API: a preflight gets nothing that grants access.
      res.writeHead(405, { Allow: 'GET, POST, PUT, PATCH, DELETE' })
      res.end()
      return true
    }

    let route: WebRoute | undefined
    let match: RegExpExecArray | null = null
    let pathMatched = false
    for (const r of routes) {
      const m = r.pattern.exec(rawPath)
      if (!m) continue
      pathMatched = true
      if (r.method.toUpperCase() !== method && !(method === 'HEAD' && r.method.toUpperCase() === 'GET')) continue
      route = r
      match = m
      break
    }
    if (!route || !match) {
      if (pathMatched) sendError(res, 405, 'method_not_allowed')
      else sendError(res, 404, 'not_found')
      return true
    }

    const secure = overTls(req)
    let chatId = ''
    let sessionIdHash = ''

    if (route.auth) {
      const presented = webSessionFromCookies(req.headers.cookie) ?? ''
      const session = resolveWebSession(presented)
      if (!session) {
        sendError(res, 401, 'unauthorized')
        return true
      }
      // Re-checked on every request so revoking a chat locks the web out too.
      // Its sessions go with it, so allowing the chat again later does not
      // bring old browsers back.
      if (!isChatAllowed(session.chatId)) {
        revokeAllWebSessions(session.chatId)
        sendError(res, 401, 'unauthorized')
        return true
      }
      chatId = session.chatId
      sessionIdHash = session.idHash
      // The session slid on the server: tell the browser too, or it drops the
      // cookie at the Max-Age it was first given. A handler that sets its own
      // cookie (sign out) overrides this through writeHead.
      if (session.slid) res.setHeader('Set-Cookie', webSessionCookie(presented, secure, SESSION_TTL_MS))
    }

    if (method !== 'GET' && method !== 'HEAD') {
      if (route.upload) {
        if (req.headers['x-havn-web'] !== '1') return sendError(res, 403, 'missing_header'), true
      } else if (!requireJson(req)) {
        return sendError(res, 415, 'unsupported_media_type'), true
      }
    }

    let params: string[]
    try {
      params = match.slice(1).map((p) => (p === undefined ? '' : decodeURIComponent(p)))
    } catch {
      return sendError(res, 400, 'bad_path'), true
    }

    await route.handler({ req, res, url, params, chatId, sessionIdHash, secure })
    return true
  } catch (err) {
    if (err instanceof BodyError) {
      sendError(res, err.status, err.code)
      return true
    }
    logger.error({ err, path: rawPath }, 'web route failed')
    if (!res.headersSent) sendError(res, 500, 'internal_error')
    else res.end()
    return true
  }
}

// ---------- session routes ----------

/** "Chrome on macOS", at most 60 characters. Never the raw User-Agent. */
export function sessionLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  return (os ? `${browser} on ${os}` : browser).slice(0, 60)
}

function readIfExists(file: string): string | null {
  try {
    return readFileSync(resolve(PROJECT_ROOT, file), 'utf-8')
  } catch {
    return null
  }
}

function currentAssistantName(): string {
  const env = process.env.ASSISTANT_NAME?.trim()
  if (env) return env
  return assistantName(readIfExists('PERSONALITY.md'), readIfExists('CLAUDE.md')) ?? 'Assistant'
}

async function body(ctx: WebContext): Promise<Record<string, unknown>> {
  const parsed = await readJsonCapped(ctx.req)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError(400, 'bad_json')
  return parsed as Record<string, unknown>
}

registerWebRoutes([
  {
    method: 'POST',
    pattern: /^\/api\/web\/session$/,
    auth: false,
    async handler(ctx) {
      // Every attempt counts, successful or not.
      if (!allowAttempt(clientIp(ctx.req))) return sendError(ctx.res, 429, 'too_many_attempts', { 'Retry-After': '600' })
      const b = await body(ctx)
      const token = typeof b.token === 'string' ? b.token : ''
      const made = exchangeWebLink(token, sessionLabel(ctx.req.headers['user-agent']))
      if (!made) return sendError(ctx.res, 401, 'invalid_link')
      sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': webSessionCookie(made.sessionId, ctx.secure, SESSION_TTL_MS) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/me$/,
    auth: true,
    handler(ctx) {
      sendJson(ctx.res, 200, {
        chatId: ctx.chatId,
        isPrimary: PRIMARY_CHAT_ID !== '' && ctx.chatId === PRIMARY_CHAT_ID,
        assistantName: currentAssistantName(),
        // Whether the box can transcribe the chat box's microphone (card #252).
        transcribe: dictationDeps().canTranscribe(),
        // Whether the chat bar may start a live voice call (card #248).
        voiceChat: voiceChatAvailable(ctx.chatId),
        // The call bar's voice dropdown (card #257).
        voices: [...LIVE_VOICES],
        defaultVoice: (LIVE_VOICES as readonly string[]).includes(LIVE_VOICE) ? LIVE_VOICE : LIVE_VOICES[0],
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/signout$/,
    auth: true,
    handler(ctx) {
      revokeWebSession(ctx.chatId, ctx.sessionIdHash)
      sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': clearWebCookie(ctx.secure) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/sessions$/,
    auth: true,
    handler(ctx) {
      const sessions = listWebSessions(ctx.chatId).map((s) => ({ ...s, current: s.idHash === ctx.sessionIdHash }))
      sendJson(ctx.res, 200, { sessions })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/sessions\/revoke$/,
    auth: true,
    async handler(ctx) {
      const b = await body(ctx)
      if (b.others === true) {
        return sendJson(ctx.res, 200, { ok: true, revoked: revokeOtherWebSessions(ctx.chatId, ctx.sessionIdHash) })
      }
      if (typeof b.idHash === 'string' && /^[0-9a-f]{64}$/.test(b.idHash)) {
        const ok = revokeWebSession(ctx.chatId, b.idHash)
        const headers: Record<string, string> = b.idHash === ctx.sessionIdHash ? { 'Set-Cookie': clearWebCookie(ctx.secure) } : {}
        return sendJson(ctx.res, 200, { ok: true, revoked: ok ? 1 : 0 }, headers)
      }
      sendError(ctx.res, 400, 'bad_request')
    },
  },
])
