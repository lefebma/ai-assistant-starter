/**
 * Live voice: OpenAI GPT-Live-1 owns the audio, the assistant owns the thinking.
 *
 *   browser mic/speaker <-> WebRTC <-> GPT-Live-1
 *                                        ^ sideband WebSocket (this module)
 *                                        | session.delegation.created
 *                                        v
 *                                    runAgent (the assistant, with its skills)
 *
 * GPT-Live-1 listens while it talks, handles interruptions and small talk, and
 * decides when something needs real work. It then "delegates": this module
 * gets an event, runs the assistant, and hands the result back to be spoken.
 * The browser only ever gets audio and captions. Session creation, the
 * transcript used to build backend prompts, and the OpenAI key stay here.
 *
 * Client delegation carries no task text. session.delegation.created is just
 * an ID, so this module keeps its own transcript from the transcript deltas
 * and builds each backend prompt from it.
 *
 * Ported from the assistant this product came from, where it was proven
 * against real calendar, board, and web lookups of 19 to 34 seconds.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { OPENAI_API_KEY, LIVE_VOICE, PROJECT_ROOT, STORE_DIR, PRIMARY_CHAT_ID } from './config.js'
import { installTimezone } from './env.js'
import { runAgent } from './agent.js'
import { identity } from './workspace/registry.js'
import { saveConversationTurn } from './memory.js'
import { insertMemory } from './db.js'
import { createDefaultEngine, type ContextEngine } from './memory/engine.js'
import { buildSkillIndex } from './skills/index.js'
import { logger } from './logger.js'

const LIVE_MODEL = 'gpt-live-1'
const LIVE_API = 'https://api.openai.com/v1/live/sessions'
const RESULT_CHUNK_CHARS = 1500 // appends cap at 500 tokens each
const MAX_CONCURRENT_SESSIONS = 2
const MAX_SESSION_MS = 45 * 60_000 // billed per second; don't let a forgotten tab run all day
const PERSONALITY_EXCERPT_CHARS = 2500
const TRANSCRIPT_ROOT = () => resolve(STORE_DIR, 'voice-transcripts') // store/ is preserved by updates
const RECENT_CALLS = 2
const RECENT_CALL_CHARS = 1200
const RECENT_CALL_MAX_AGE_DAYS = 7

export const LIVE_VOICES = ['gleam', 'meridian', 'vesper', 'willow', 'stone', 'ripple', 'quartz', 'beacon', 'delta', 'cinder'] as const

function personalityExcerpt(root: string = PROJECT_ROOT): string {
  try {
    const text = readFileSync(resolve(root, 'PERSONALITY.md'), 'utf-8').trim()
    return text.length > PERSONALITY_EXCERPT_CHARS ? text.slice(0, PERSONALITY_EXCERPT_CHARS) + '...' : text
  } catch {
    return ''
  }
}

/** Instructions for the live voice model: who it is, how it sounds, when to hand off. */
export function buildLiveInstructions(
  who: { assistant: string; owner: string } = identity(),
  personality: string = personalityExcerpt(),
  recentCalls: string = '',
): string {
  const owner = who.owner || 'the user'
  return [
    `You are ${who.assistant}, ${owner}'s personal AI assistant, talking with ${owner} by voice.`,
    personality ? `Personality (from the assistant's settings; follow its tone, but keep spoken replies short):\n${personality}` : '',
    `Voice and style:
- Short spoken replies, one to three sentences. Natural and warm, no filler.
- Never read out markdown, URLs, or long IDs unless asked.`,
    `Delegation policy:
Backend tools:
- The assistant's backend has ${owner}'s connected accounts and skills (for example email, calendar, files, and web search) and can take actions.

Delegate to the backend when:
- ${owner} asks about their schedule, inbox, clients, tasks, or anything stored about them.
- The answer needs current information from the web.
- ${owner} asks you to do something (draft, create, update, schedule, look up).
- The answer needs careful reasoning beyond a quick reply.
- A correction changes a request that is already in progress.

Do not delegate to the backend when:
- ${owner} is greeting you, making small talk, or asking you to repeat a result already given.
- You can't tell what they want without a quick clarifying question.

Delegate before giving an answer that depends on backend work. Do not guess results while waiting.
While the backend works, keep the conversation natural: a brief "checking" is fine, then chat or wait.
Never claim something was sent, booked, or changed unless the backend confirmed it.`,
    recentCalls
      ? `Recent voice calls with ${owner} (most recent first). Use them when ${owner} refers back to an earlier call ("remember when we talked about...", "like I said last time"). Don't bring them up unprompted, and delegate if they need more detail than this:\n${recentCalls}`
      : '',
  ].filter(Boolean).join('\n\n')
}

function backendPreamble(owner: string): string {
  const who = owner || 'the user'
  return `[surface:voice] You are the backend for a live voice conversation with ${who}.
A separate voice model is talking with them and will speak your answer aloud (paraphrased).
Transcripts can contain recognition mistakes, unfinished phrases, and later corrections. Use the latest context.
If a needed detail is unclear, say exactly what to ask instead of guessing.
Return only the spoken-relevant facts: plain sentences, no markdown, no lists, no URLs, under 120 words.
Say whether the task is complete. Never claim an external action (send, post, delete) happened unless you did it and it succeeded.
Do not send emails or messages from a voice request unless ${who} explicitly confirmed the exact content in the conversation.`
}

type LiveEvent = { type: string; [k: string]: any }
type Send = (event: LiveEvent) => void
type Log = (msg: string, extra?: Record<string, unknown>) => void
/** Resolves with the spoken-ready result. `signal` aborts when a newer request supersedes this one. */
export type RunBackend = (prompt: string, signal: AbortSignal) => Promise<string>

const CANCELLED_NOTE = `An earlier backend request in this call was cancelled before it finished because the user kept talking (usually a correction or an add-on).
Handle everything still outstanding in the transcript below, including whatever from that earlier request still applies after the user's latest words.
The cancelled attempt may have partly run: check current state before repeating any action so nothing gets created or changed twice.`

export interface Turn {
  who: 'user' | 'assistant'
  text: string
  start_ms: number
  end_ms: number
}

/**
 * Transcript + delegation handling, independent of the transport so it can be
 * unit-tested with a fake send and backend.
 */
export function createLiveBridge(opts: { send: Send; runBackend: RunBackend; log?: Log; settleMs?: number; cancelWaitMs?: number; preamble?: string }) {
  // cancelWaitMs: how long a new request waits for the runs it cancelled to
  // wind down, so two Claude subprocesses don't resume the same session at once.
  const { send, runBackend, log = () => {}, settleMs = 700, cancelWaitMs = 3000, preamble = backendPreamble('') } = opts
  const turns: Turn[] = []
  let deliveredThrough = 0
  let latestRev = 0
  let seq = 0
  const inflight = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const metrics: { delegationId: string; ms: number; superseded: boolean; cancelled: boolean }[] = []

  const nextId = (p: string) => `${p}_${Date.now()}_${++seq}`

  function appendTranscript(who: Turn['who'], delta: string, start_ms = 0, end_ms = start_ms) {
    const last = turns[turns.length - 1]
    // Same speaker within 1.5s of session timeline is the same turn.
    if (last && last.who === who && start_ms - last.end_ms < 1500) {
      last.text += delta
      last.end_ms = end_ms
    } else {
      turns.push({ who, text: delta, start_ms, end_ms })
    }
  }

  function transcriptText(fromIdx = 0): string {
    return turns
      .slice(Math.max(0, fromIdx))
      .map((t) => `${t.who === 'user' ? 'User' : 'Assistant'}: ${t.text.trim()}`)
      .join('\n')
  }

  function sendChunks(type: string, delegationId: string, text: string) {
    for (let i = 0; i < text.length; i += RESULT_CHUNK_CHARS) {
      send({ type, event_id: nextId('result'), delegation_id: delegationId, content: text.slice(i, i + RESULT_CHUNK_CHARS) })
    }
  }

  async function handleDelegation(delegationId: string) {
    const rev = ++latestRev
    const startedAt = Date.now()
    const controller = new AbortController()
    let markDone!: () => void
    const done = new Promise<void>((r) => (markDone = r))

    // A newer request supersedes everything still running: abort it (kills the
    // Claude subprocess). This request then covers what the cancelled one asked.
    const cancelled = [...inflight.entries()]
    for (const [id, entry] of cancelled) {
      entry.controller.abort()
      log('delegation cancelled', { delegationId: id, by: delegationId })
    }
    inflight.set(delegationId, { controller, done })

    const finish = (result: string | null) => {
      const ms = Date.now() - startedAt
      inflight.delete(delegationId)
      markDone()
      const superseded = rev !== latestRev || controller.signal.aborted
      metrics.push({ delegationId, ms, superseded, cancelled: controller.signal.aborted })
      if (superseded || result === null) {
        // Drop late or cancelled results entirely: in the spike, handing a stale
        // result over as session.thinking.append still got it read aloud.
        log('delegation superseded', { delegationId, ms, cancelled: controller.signal.aborted })
        return
      }
      log('delegation done', { delegationId, ms, chars: result.length })
      sendChunks('session.commentary.append', delegationId, result)
    }

    // The delegation event can land before the tail of the utterance is
    // transcribed; give it a moment. Then let cancelled runs wind down.
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
    if (cancelled.length) {
      await Promise.race([
        Promise.all(cancelled.map(([, e]) => e.done)),
        new Promise((r) => setTimeout(r, cancelWaitMs)),
      ])
    }
    if (controller.signal.aborted) return finish(null) // superseded while waiting

    // New turns since the last backend call, with a little overlap so short
    // follow-ups ("yes", "Montreal instead") resolve. After a cancel the
    // backend starts a fresh Claude session (see createAssistantBackend), so it gets
    // the whole call instead: voice transcripts are short.
    const from = cancelled.length ? 0 : Math.max(0, deliveredThrough - 4)
    const convo = transcriptText(from)
    deliveredThrough = turns.length
    const prompt = [
      preamble,
      cancelled.length ? CANCELLED_NOTE : '',
      `Recent voice transcript:\n${convo || '(no transcript captured)'}`,
      'Work out what the user wants from the latest turns and handle it.',
    ].filter(Boolean).join('\n\n')

    log('delegation start', { delegationId, rev, cancelledPrior: cancelled.length })
    send({
      type: 'session.thinking.append',
      event_id: nextId('progress'),
      delegation_id: delegationId,
      content: 'The backend is working on this request. Nothing has been completed yet.',
    })

    let result: string | null
    try {
      const text = await runBackend(prompt, controller.signal)
      result = controller.signal.aborted ? null : text.trim() || 'The backend returned nothing.'
    } catch (err) {
      if (controller.signal.aborted) {
        result = null
      } else {
        log('delegation error', { delegationId, err: String(err) })
        result = 'The backend hit an error and could not finish that request.'
      }
    }
    finish(result)
  }

  return {
    onEvent(event: LiveEvent) {
      switch (event.type) {
        case 'session.input_transcript.delta':
          appendTranscript('user', String(event.delta ?? ''), event.start_ms, event.end_ms)
          break
        case 'session.output_transcript.delta':
          appendTranscript('assistant', String(event.delta ?? ''), event.start_ms, event.end_ms)
          break
        case 'session.delegation.created':
          if (event.delegation?.target === 'client' && event.delegation.id) {
            return handleDelegation(String(event.delegation.id))
          }
          break
        case 'error':
          log('live error', { error: event.error })
          break
      }
      return undefined
    },
    greet() {
      send({
        type: 'session.instructions.append',
        event_id: nextId('greet'),
        delegation_id: null,
        content: 'Greet the user immediately in English with a short, casual line, then pause and listen.',
      })
    },
    transcript: () => transcriptText(0),
    turns: () => turns.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text),
    metrics: () => metrics.slice(),
    busy: () => inflight.size > 0,
  }
}

/**
 * Voice memory is filed under the chat that owns the voice link, so the chat
 * surface (Telegram, Teams) remembers what was said on a call and the call
 * sees recent chat. The operator bearer carries no chat; that falls back to
 * the primary chat.
 */
export function memoryChatId(chatId: string | null | undefined): string {
  return chatId || PRIMARY_CHAT_ID || 'voice'
}

/**
 * One directory per chat. Chat ids come from platforms (Teams ids carry ':',
 * '@' and '.'), so map everything but letters, digits, '_' and '-' to '_'.
 * Dots go too: a chat id of '..' must never resolve outside the transcript
 * root. The containment check is the backstop if the mapping ever changes.
 */
export function transcriptDirFor(chatId: string, root: string = TRANSCRIPT_ROOT()): string {
  const safe = chatId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'voice'
  const base = resolve(root)
  const dir = resolve(base, safe)
  if (!dir.startsWith(base + sep)) throw new Error('voice transcript path escaped its root')
  return dir
}

export interface VoiceCallRecord {
  sessionId: string
  chatId: string
  startedAt: Date
  endedAt: Date
  turns: Turn[]
  delegations: number
  billedSeconds?: number
}

export interface VoiceCallDeps {
  dir?: string
  timezone?: string
  writeFile?: (path: string, content: string) => void
  saveTurn?: (chatId: string, user: string, assistant: string) => Promise<void>
  insert?: (chatId: string, content: string, sector: 'semantic' | 'episodic') => void
}

const zonedTime = (d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, ...opts }).format(d)

/**
 * Persist a finished call: the full transcript as markdown under
 * store/voice-transcripts/<chat>/, each exchange as a regular conversation-turn
 * memory (same filters as chat: short turns are skipped), and one episodic
 * memory summarizing the call with a pointer to the transcript. A call where
 * the user never spoke saves nothing. Returns the transcript path or null.
 */
export async function saveVoiceCall(call: VoiceCallRecord, deps: VoiceCallDeps = {}): Promise<string | null> {
  const dir = deps.dir ?? transcriptDirFor(call.chatId)
  const timeZone = deps.timezone ?? installTimezone()
  const writeFile = deps.writeFile ?? ((path: string, content: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, content, { mode: 0o600 })
  })
  const saveTurn = deps.saveTurn ?? saveConversationTurn
  const insert = deps.insert ?? insertMemory

  const turns = call.turns.filter((t) => t.text.trim())
  const userSaid = turns.filter((t) => t.who === 'user').map((t) => t.text.trim())
  if (userSaid.length === 0) return null

  const minutes = Math.max(1, Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 60_000))
  const stamp = zonedTime(call.startedAt, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .replace(/[^\d]+/g, '-').replace(/-$/, '')
  const when = zonedTime(call.startedAt, timeZone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const path = resolve(dir, `${stamp}-${call.sessionId.slice(-6)}.md`)
  const lookups = `${call.delegations} backend lookup${call.delegations === 1 ? '' : 's'}`

  writeFile(path, [
    `# Voice call, ${when}`,
    '',
    `- Duration: ~${minutes} min${call.billedSeconds ? ` (${call.billedSeconds}s billed)` : ''}`,
    `- ${lookups[0].toUpperCase()}${lookups.slice(1)}`,
    `- Session: ${call.sessionId}`,
    '',
    ...turns.map((t) => `**${t.who === 'user' ? 'User' : 'Assistant'}:** ${t.text.trim()}\n`),
  ].join('\n'))

  // Pair each run of user turns with the assistant turns that follow it.
  for (let i = 0; i < turns.length; ) {
    if (turns[i].who !== 'user') { i++; continue }
    const user: string[] = []
    const reply: string[] = []
    while (i < turns.length && turns[i].who === 'user') user.push(turns[i++].text.trim())
    while (i < turns.length && turns[i].who === 'assistant') reply.push(turns[i++].text.trim())
    const userText = user.join(' ')
    if (userText.length <= 20) continue // the same threshold chat uses, measured before the prefix
    await saveTurn(call.chatId, `(by voice) ${userText}`, reply.join(' '))
  }

  const said = userSaid.join(' / ')
  insert(
    call.chatId,
    `Voice call on ${when} (~${minutes} min, ${lookups}). The user said: ${said.length > 240 ? said.slice(0, 240) + '...' : said} [transcript: ${relative(PROJECT_ROOT, path)}]`,
    'episodic',
  )
  return path
}

/**
 * The tail of the last couple of calls, for the voice model's instructions, so
 * "do you remember what we talked about?" gets an answer without a lookup.
 * Reads the transcripts saveVoiceCall wrote; skips anything older than a week.
 */
export function recentCallsNote(
  chatId: string,
  opts: { dir?: string; now?: number; maxCalls?: number; perCallChars?: number; maxAgeDays?: number } = {},
): string {
  const dir = opts.dir ?? transcriptDirFor(chatId)
  const now = opts.now ?? Date.now()
  const maxAgeMs = (opts.maxAgeDays ?? RECENT_CALL_MAX_AGE_DAYS) * 86_400_000
  let files: { path: string; mtime: number }[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ path: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
      .filter((f) => now - f.mtime <= maxAgeMs)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, opts.maxCalls ?? RECENT_CALLS)
  } catch {
    return ''
  }
  const perCall = opts.perCallChars ?? RECENT_CALL_CHARS
  return files
    .map((f) => {
      const raw = readFileSync(f.path, 'utf-8')
      const heading = raw.match(/^# (.+)$/m)?.[1] ?? 'Voice call'
      const body = raw.split('\n').filter((l) => l.startsWith('**')).join('\n').replace(/\*\*/g, '')
      const tail = body.length > perCall ? '...' + body.slice(body.length - perCall) : body
      return `${heading}:\n${tail}`
    })
    .join('\n\n')
}

let engine: ContextEngine | undefined

/**
 * The assistant as the delegation backend: one Claude session per live call,
 * with the same skill index and memory context a chat message gets.
 */
export function createAssistantBackend(chatId: string = memoryChatId(null)): RunBackend {
  let sessionId: string | undefined
  return async (prompt, signal) => {
    engine ??= createDefaultEngine()
    const memoryContext = await engine.buildContext(chatId, prompt).catch(() => '')
    const full = [buildSkillIndex(), memoryContext, prompt].filter(Boolean).join('\n\n')
    const { text, newSessionId } = await runAgent(full, sessionId, undefined, undefined, undefined, 'chat', signal)
    if (signal.aborted) {
      // Never resume a session a cancelled run touched: resuming it right after
      // the abort failed with error_during_execution and then an unhandled
      // EPIPE (see src/infra/epipe-guard.ts). The next request starts fresh and
      // the bridge sends it the whole call.
      sessionId = undefined
      return ''
    }
    if (newSessionId) sessionId = newSessionId
    return text ?? ''
  }
}

const activeSessions = new Map<string, { close: () => void }>()

/**
 * The sideband needs a WebSocket client with custom headers. Node 22 has one
 * built in; Node 20 (still allowed by `engines`) does not. Hosted boxes run 22.
 * Checked before creating the OpenAI session, which starts billing, so an
 * older Node refuses cleanly instead of orphaning a live session.
 */
export function liveRuntimeSupported(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
}

export function liveStatus() {
  return { enabled: !!OPENAI_API_KEY && liveRuntimeSupported(), nodeSupported: liveRuntimeSupported(), active: activeSessions.size, max: MAX_CONCURRENT_SESSIONS, voices: LIVE_VOICES, defaultVoice: LIVE_VOICE, assistant: identity().assistant }
}

export class LiveSessionError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

/**
 * Exchange a browser SDP offer for an answer, then attach the sideband that
 * runs delegation. Returns OpenAI's JSON ({session:{id}, transport:{sdp}}).
 */
export async function createLiveSession(sdp: string, voice?: string, chatId?: string | null): Promise<unknown> {
  if (!OPENAI_API_KEY) throw new LiveSessionError(503, 'openai_not_configured')
  if (!liveRuntimeSupported()) throw new LiveSessionError(503, 'node_22_required')
  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) throw new LiveSessionError(429, 'too_many_sessions')
  const chosenVoice = (LIVE_VOICES as readonly string[]).includes(voice ?? '') ? voice : LIVE_VOICE
  const who = identity()
  const chat = memoryChatId(chatId)
  let recent = ''
  try {
    recent = recentCallsNote(chat)
  } catch (err) {
    logger.warn({ err }, 'could not read recent voice calls')
  }

  const upstream = await fetch(LIVE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        model: LIVE_MODEL,
        instructions: buildLiveInstructions(who, personalityExcerpt(), recent),
        audio: { output: { voice: chosenVoice } },
        delegation: { type: 'client' },
      },
      transport: { type: 'webrtc', sdp },
    }),
  })
  const body = await upstream.text()
  if (!upstream.ok) {
    logger.error({ status: upstream.status, body: body.slice(0, 500) }, 'live session create failed')
    throw new LiveSessionError(502, 'upstream_failed')
  }
  const result = JSON.parse(body) as { session?: { id?: string } }
  const sessionId = result.session?.id
  if (!sessionId) throw new LiveSessionError(502, 'no_session_id')
  logger.info({ sessionId, voice: chosenVoice, chatId, recentCalls: !!recent }, 'live session created')
  attachSideband(sessionId, backendPreamble(who.owner), chat)
  return result
}

function attachSideband(sessionId: string, preamble: string, chatId: string): void {
  const ws = new WebSocket(`${LIVE_API.replace('https://', 'wss://')}/${encodeURIComponent(sessionId)}/attach`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  } as any)
  const send: Send = (event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
  }
  const bridge = createLiveBridge({
    send,
    runBackend: createAssistantBackend(chatId),
    preamble,
    log: (msg, extra) => logger.info({ sessionId, ...extra }, `live: ${msg}`),
  })

  const close = () => send({ type: 'session.close' })
  activeSessions.set(sessionId, { close })
  const startedAt = new Date()
  let persisted = false
  // Once, on session.closed or on a sideband that dropped before getting there.
  const persist = (billedSeconds?: number) => {
    if (persisted) return
    persisted = true
    saveVoiceCall({ sessionId, chatId, startedAt, endedAt: new Date(), turns: bridge.turns(), delegations: bridge.metrics().length, billedSeconds })
      .then((path) => path && logger.info({ sessionId, path }, 'live call saved to memory'))
      .catch((err) => logger.error({ err, sessionId }, 'live call save failed'))
  }
  const maxTimer = setTimeout(() => {
    logger.warn({ sessionId }, 'live session hit max duration, closing')
    close()
  }, MAX_SESSION_MS)

  ws.addEventListener('open', () => {
    logger.info({ sessionId }, 'live sideband attached')
    bridge.greet()
  })
  ws.addEventListener('message', (msg: MessageEvent) => {
    let event: LiveEvent
    try {
      event = JSON.parse(typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data as ArrayBuffer).toString())
    } catch {
      return
    }
    if (event.type.endsWith('audio.delta')) return
    void bridge.onEvent(event)
    if (event.type === 'session.closed') {
      logger.info({ sessionId, usage: event.usage, delegations: bridge.metrics() }, 'live session closed')
      persist(typeof event.usage?.seconds === 'number' ? event.usage.seconds : undefined)
      ws.close()
    }
  })
  ws.addEventListener('close', () => {
    persist()
    clearTimeout(maxTimer)
    activeSessions.delete(sessionId)
    logger.info({ sessionId }, 'live sideband closed')
  })
  ws.addEventListener('error', () => logger.warn({ sessionId }, 'live sideband error'))
}
