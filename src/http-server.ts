import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { PROJECT_ROOT, HTTP_PORT, HTTP_BEARER_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, PRIMARY_CHAT_ID } from './config.js'
import { runAgent } from './agent.js'
import { sendTelegramMessage } from './bot.js'
import { logger } from './logger.js'
import https from 'node:https'
import { getUsageSnapshot, getActivitySeries } from './cockpit/usage.js'
import { readRecentActivity } from './cockpit/activity.js'
import { getDeclaredMcpServers } from './cockpit/mcp.js'
import { publicRegistry } from './cockpit/registry.js'
import { handleRun, handleCancel, readLastRun, getActiveRun } from './cockpit/run.js'

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

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!HTTP_BEARER_TOKEN) return true
  const h = req.headers.authorization ?? ''
  if (h === `Bearer ${HTTP_BEARER_TOKEN}`) return true
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

  const convoKey =
    payload.conversation_id ??
    (payload.metadata as any)?.conversation_id ??
    payload.user ??
    'voice-default'
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
        await sendTelegramMessage(PRIMARY_CHAT_ID, text).catch((err) =>
          logger.warn({ err }, 'voice→telegram fallback failed'),
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

export function startHttpServer(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      void handleChatCompletions(req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/signed-url') {
      void handleSignedUrl(req, res)
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
  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info({ port: HTTP_PORT }, 'HTTP server listening (voice/custom-LLM/cockpit)')
  })
  httpServer = server
}
