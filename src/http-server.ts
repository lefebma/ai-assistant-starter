import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { PROJECT_ROOT, HTTP_PORT, HTTP_BEARER_TOKEN, OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PRIMARY_CHAT_ID } from './config.js'
import { transcribeAudio } from './voice.js'
import { resolveVoiceToken } from './voice-links.js'
import { runAgent } from './agent.js'
import { sendPlatformMessage } from './bot.js'
import { logger } from './logger.js'
import https from 'node:https'
import { getUsageSnapshot, getActivitySeries } from './cockpit/usage.js'
import { readRecentActivity } from './cockpit/activity.js'
import { getDeclaredMcpServers } from './cockpit/mcp.js'
import { publicRegistry } from './cockpit/registry.js'
import { handleRun, handleCancel, readLastRun, getActiveRun } from './cockpit/run.js'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

// Routes registered by platform adapters (the Teams webhook). Consulted at
// request time, before the built-in routes, so registration order relative to
// listen() does not matter. They carry their own authentication and are
// deliberately not behind requireAuth().
const registeredRoutes = new Map<string, RouteHandler>()

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`
}

export function registerHttpRoute(method: string, pathname: string, handler: RouteHandler): () => void {
  const key = routeKey(method, pathname)
  registeredRoutes.set(key, handler)
  return () => {
    if (registeredRoutes.get(key) === handler) registeredRoutes.delete(key)
  }
}

// If a voice turn takes longer than this without streaming content, hand off to Telegram instead.
const VOICE_TIMEOUT_MS = 12_000

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

// ElevenLabs conversation_id -> Claude Code session_id
const conversationSessions = new Map<string, string>()

const PUBLIC_DIR = resolve(PROJECT_ROOT, 'public')

function mime(path: string): string {
  const ext = extname(path).toLowerCase()
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[ext] ?? 'application/octet-stream'
  )
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Bare token from an `Authorization: Bearer <token>` header, or ''. */
function bearerFrom(req: IncomingMessage): string {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

/**
 * Who is calling. Two credentials are accepted:
 *   - HTTP_BEARER_TOKEN, the box-wide operator credential (no chat identity)
 *   - a per-chat voice link minted by `/voice ui` (carries the chat id)
 * With no HTTP_BEARER_TOKEN configured the server is unauthenticated, which is
 * the loopback-only default; the hosted edge always sets one.
 */
function authContext(req: IncomingMessage): { ok: boolean; chatId: string | null } {
  const token = bearerFrom(req)
  if (HTTP_BEARER_TOKEN && token === HTTP_BEARER_TOKEN) return { ok: true, chatId: null }
  const chatId = resolveVoiceToken(token)
  if (chatId) return { ok: true, chatId }
  if (!HTTP_BEARER_TOKEN) return { ok: true, chatId: null }
  return { ok: false, chatId: null }
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (authContext(req).ok) return true
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized' }))
  return false
}

function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function openaiChunk(id: string, model: string, delta: Partial<{ role: string; content: string }>, finish?: string) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

function openaiComplete(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return
  const auth = authContext(req)

  let payload: {
    messages: Msg[]
    stream?: boolean
    model?: string
    user?: string
    conversation_id?: string
    metadata?: Record<string, unknown>
  }
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_json' }))
    return
  }

  const lastUser = [...(payload.messages ?? [])].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'no_user_message' }))
    return
  }

  // A caller holding a voice link gets its own namespace. Without this, a
  // client-supplied conversation_id is enough to land on another chat's Claude
  // session on a box serving more than one authorized chat.
  const clientKey =
    payload.conversation_id ??
    (payload.metadata as any)?.conversation_id ??
    payload.user ??
    'default'
  const convoKey = auth.chatId ? `voice:${auth.chatId}:${clientKey}` : clientKey === 'default' ? 'voice-default' : clientKey
  const existingSession = conversationSessions.get(convoKey)
  const completionId = `chatcmpl-${Date.now()}`
  const model = payload.model ?? 'umi'
  const stream = payload.stream !== false

  logger.info({ convoKey, existingSession, stream }, 'voice chat completion')

  if (!stream) {
    const { text, newSessionId } = await runAgent(lastUser.content, existingSession)
    if (newSessionId) conversationSessions.set(convoKey, newSessionId)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(openaiComplete(completionId, model, text ?? '')))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  res.write(sseFrame(openaiChunk(completionId, model, { role: 'assistant' })))

  // Heartbeat SSE comments keep proxies from dropping the connection during slow backend thinks.
  const heartbeat = setInterval(() => {
    res.write(`: keep-alive ${Date.now()}\n\n`)
  }, 2000)

  let lastSent = ''
  let handedOffToTelegram = false

  // Timer: if no content token arrives within VOICE_TIMEOUT_MS, fast-ack in voice and route
  // the full answer to Telegram to avoid ElevenLabs' 15s hard cutoff on tool-use turns.
  const timeoutHandle = setTimeout(() => {
    if (lastSent.length > 0 || handedOffToTelegram) return
    handedOffToTelegram = true
    const ack = "On it. I'll send the details to Telegram."
    res.write(sseFrame(openaiChunk(completionId, model, { content: ack })))
    res.write(sseFrame(openaiChunk(completionId, model, {}, 'stop')))
    res.write('data: [DONE]\n\n')
    clearInterval(heartbeat)
    res.end()
  }, VOICE_TIMEOUT_MS)

  const onPartial = (accumulated: string): void => {
    if (handedOffToTelegram) return
    const delta = accumulated.slice(lastSent.length)
    if (!delta) return
    lastSent = accumulated
    res.write(sseFrame(openaiChunk(completionId, model, { content: delta })))
  }

  try {
    const { text, newSessionId } = await runAgent(lastUser.content, existingSession, undefined, onPartial)
    if (newSessionId) conversationSessions.set(convoKey, newSessionId)

    if (handedOffToTelegram) {
      // Voice already closed — push the real answer to Telegram.
      if (PRIMARY_CHAT_ID && text) {
        await sendPlatformMessage(PRIMARY_CHAT_ID, text).catch((e: unknown) =>
          logger.warn({ err: e }, 'voice fallback failed'),
        )
      }
      return
    }

    clearTimeout(timeoutHandle)
    // Flush any tail that wasn't streamed via partials
    if (text && text.length > lastSent.length) {
      res.write(sseFrame(openaiChunk(completionId, model, { content: text.slice(lastSent.length) })))
    }
    res.write(sseFrame(openaiChunk(completionId, model, {}, 'stop')))
    res.write('data: [DONE]\n\n')
  } catch (err) {
    logger.error({ err }, 'voice agent failed')
    if (!handedOffToTelegram) {
      res.write(sseFrame(openaiChunk(completionId, model, { content: '\n\n(error)' }, 'stop')))
      res.write('data: [DONE]\n\n')
    }
  } finally {
    clearTimeout(timeoutHandle)
    clearInterval(heartbeat)
    if (!handedOffToTelegram) res.end()
  }
}

/** Whisper picks its decoder from the filename, so the extension must match
 *  what the browser actually recorded. Safari records MP4, Chrome WebM. */
export function audioExtension(contentType: string | undefined): string {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/oga': 'oga',
    // Safari records audio-only ISO-BMFF. OpenAI rejects that named .mp4
    // ("Invalid file format") but accepts the identical bytes as .m4a.
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/aac': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
  }
  return map[base] ?? 'webm'
}

async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return
  if (!OPENAI_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'openai_not_configured' }))
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  const body = Buffer.concat(chunks)

  if (body.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'empty_body' }))
    return
  }

  const tmpDir = resolve(PROJECT_ROOT, 'store')
  mkdirSync(tmpDir, { recursive: true })
  const ext = audioExtension(req.headers['content-type'])
  logger.info({ bytes: body.length, contentType: req.headers['content-type'], ext }, 'transcribe request')
  const tmpPath = resolve(tmpDir, `voice_${Date.now()}.${ext}`)
  try {
    writeFileSync(tmpPath, body)
    const text = await transcribeAudio(tmpPath)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text }))
  } catch (err) {
    logger.error({ err }, 'transcribe failed')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'transcription_failed' }))
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }
}

async function handleSignedUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'elevenlabs_not_configured' }))
    return
  }

  const opts = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`,
    method: 'GET',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  }

  await new Promise<void>((resolvePromise) => {
    const r = https.request(opts, (upstream) => {
      let data = ''
      upstream.on('data', (c) => (data += c))
      upstream.on('end', () => {
        res.writeHead(upstream.statusCode ?? 500, { 'Content-Type': 'application/json' })
        res.end(data)
        resolvePromise()
      })
    })
    r.on('error', (err) => {
      logger.error({ err }, 'signed-url fetch failed')
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'upstream_failed' }))
      resolvePromise()
    })
    r.end()
  })
}

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  const rel = urlPath === '/' ? '/voice.html' : urlPath
  const filePath = resolve(PUBLIC_DIR, '.' + rel)
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': mime(filePath) })
  res.end(readFileSync(filePath))
}

let httpServer: Server | undefined

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
    httpServer = undefined
  })
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  // Cockpit lives at the Vite dev server (:3001) or the static build origin.
  // Loopback-only server, so reflecting any localhost origin is safe.
  const origin = req.headers.origin
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
}

function handleCockpitJson<T>(req: IncomingMessage, res: ServerResponse, payload: () => T): void {
  if (!requireAuth(req, res)) return
  try {
    const data = payload()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  } catch (err) {
    logger.error({ err }, 'cockpit endpoint failed')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'internal_error' }))
  }
}

export function startHttpServer(port: number = HTTP_PORT): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const registered = registeredRoutes.get(routeKey(req.method ?? 'GET', url.pathname))
    if (registered) {
      Promise.resolve(registered(req, res)).catch((err) => {
        logger.error({ err, path: url.pathname }, 'registered route failed')
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      })
      return
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      void handleChatCompletions(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      void handleTranscribe(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/signed-url') {
      void handleSignedUrl(req, res)
      return
    }
    if (req.method === 'GET' && (url.pathname === '/voice' || url.pathname === '/voice/')) {
      // The edge proxies this path without inspecting the token, so the check
      // lives here. Serving the shell to an unauthenticated caller would leak
      // nothing (it is inert without a token), but a 403 keeps the box quiet.
      const token = url.searchParams.get('token') ?? ''
      const ok = resolveVoiceToken(token) !== null || (!!HTTP_BEARER_TOKEN && token === HTTP_BEARER_TOKEN)
      if (!ok) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('This voice link is not valid or has expired. Send /voice ui in your chat for a new one.')
        return
      }
      serveStatic(req, res, '/voice.html')
      return
    }
    if (req.method === 'GET' && url.pathname === '/r1') {
      const filePath = resolve(PUBLIC_DIR, 'r1.html')
      if (!existsSync(filePath)) {
        res.writeHead(404); res.end('not found'); return
      }
      const html = readFileSync(filePath, 'utf-8').replace(
        '</head>',
        `<script>window.__UMI_BOOT__={token:${JSON.stringify(HTTP_BEARER_TOKEN ?? '')},host:${JSON.stringify(req.headers.host ?? '')}}</script></head>`,
      )
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      if (!requireAuth(req, res)) return
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ agentId: ELEVENLABS_AGENT_ID }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/cockpit/usage') {
      handleCockpitJson(req, res, () => getUsageSnapshot())
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/cockpit/activity') {
      handleCockpitJson(req, res, () => ({
        series: getActivitySeries(),
        recent: readRecentActivity(50),
      }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/cockpit/mcp') {
      handleCockpitJson(req, res, () => ({ servers: getDeclaredMcpServers() }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/cockpit/skills') {
      handleCockpitJson(req, res, () => ({ skills: publicRegistry() }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/cockpit/last-run') {
      handleCockpitJson(req, res, () => ({ lastRun: readLastRun(), active: getActiveRun() }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/cockpit/run') {
      if (!requireAuth(req, res)) return
      void handleRun(req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/cockpit/cancel') {
      if (!requireAuth(req, res)) return
      handleCancel(req, res)
      return
    }
    if (req.method === 'GET') {
      serveStatic(req, res, url.pathname)
      return
    }
    res.writeHead(405)
    res.end('method not allowed')
  })

  // Bind to 0.0.0.0 so the dashboard's Cockpit tab can reach Umi from other devices
  // on the LAN. Bearer-token auth (HTTP_BEARER_TOKEN) is the security boundary.
  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP server listening (voice/custom-LLM/cockpit)')
  })
  httpServer = server
}
