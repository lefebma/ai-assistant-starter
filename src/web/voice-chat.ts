/**
 * Voice chat from the web chat bar (card #248): the live two-way voice the
 * /voice/live page already has, started inside a web conversation.
 *
 * The page signs in with its web session, so it needs no voice link. The box
 * still creates the OpenAI session and holds the key; the browser only gets
 * the SDP answer and the session id. When the call ends, however it ends, its
 * transcript is added to the conversation as messages marked as voice, and
 * the next typed turn in that conversation is told what was said.
 *
 * Calls bill per second, so every way out ends the session: the End button,
 * leaving the page, deleting the conversation, and the live voice module's
 * own idle and maximum-length limits.
 */
import { OPENAI_API_KEY } from '../config.js'
import { isManagedAi } from '../ai-limit.js'
import { createLiveSession, endLiveSession, liveRuntimeSupported, memoryChatId, type EndedCall, type Turn } from '../voice-live.js'
import { logger } from '../logger.js'
import { addMessage, getConversation, listMessages, updateConversation, type MessageRow } from './conversations.js'

/** Why this box cannot start a voice chat. Empty when it can. */
export type VoiceChatBlock = '' | 'not_configured' | 'managed_ai' | 'node_22_required'

export interface VoiceChatStart {
  sdp: string
  voice?: string
  chatId: string
  /** The conversation's latest messages, for both models. */
  chatContext: string
  /** Text the assistant wants in the chat rather than read aloud. */
  deliver(text: string): Promise<boolean>
  onEnded(call: EndedCall): void
}

export interface VoiceChatDeps {
  block(chatId: string): VoiceChatBlock
  /** Creates the paid session. Resolves to OpenAI's answer. */
  start(input: VoiceChatStart): Promise<{ session?: { id?: string }; transport?: { sdp?: string } }>
  /** Close a session this chat opened. False when it was not open. */
  end(sessionId: string, chatId: string): boolean
}

const realDeps: VoiceChatDeps = {
  block() {
    // The same rule as dictation: a managed-AI box carries no voice billing.
    if (isManagedAi()) return 'managed_ai'
    if (!OPENAI_API_KEY) return 'not_configured'
    if (!liveRuntimeSupported()) return 'node_22_required'
    return ''
  },
  start: (input) =>
    createLiveSession(input.sdp, input.voice, input.chatId, (_chat, text) => input.deliver(text), {
      chatContext: input.chatContext,
      onEnded: input.onEnded,
    }) as Promise<{ session?: { id?: string }; transport?: { sdp?: string } }>,
  end: (sessionId, chatId) => endLiveSession(sessionId, memoryChatId(chatId)),
}

let deps: VoiceChatDeps = realDeps

export function voiceChatDeps(): VoiceChatDeps {
  return deps
}

/** Test hook: stub the live session so no paid call is made. Pass null to restore. */
export function setVoiceChatDepsForTest(d: VoiceChatDeps | null): void {
  deps = d ?? realDeps
  calls.clear()
}

/** Whether the chat bar may offer a voice chat (`/api/web/me` carries it). */
export function voiceChatAvailable(chatId: string): boolean {
  return deps.block(chatId) === ''
}

// ---------- the transcript in the conversation ----------

/** Something the assistant sent to the chat during the call, and when. */
export interface Delivery {
  at: number
  text: string
}

export interface CallMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A finished call as conversation messages, in the order they were said.
 * A speaker's turns in a row become one message. What the assistant sent to
 * the chat during the call sits after the turn that was under way when it
 * arrived. A call where the user never spoke adds nothing, the same rule the
 * call history uses.
 */
export function callMessages(turns: Pick<Turn, 'who' | 'text' | 'start_ms'>[], startedAtMs: number, deliveries: Delivery[] = []): CallMessage[] {
  const spoken = turns.map((t) => ({ who: t.who, text: t.text.trim(), at: startedAtMs + (t.start_ms || 0) })).filter((t) => t.text)
  if (!spoken.some((t) => t.who === 'user')) return []
  type Item = { role: 'user' | 'assistant'; text: string; at: number; delivery: boolean }
  const items: Item[] = spoken.map((t) => ({ role: t.who, text: t.text, at: t.at, delivery: false }))
  for (const d of deliveries) {
    const text = d.text.trim()
    if (!text) continue
    let i = items.length
    while (i > 0 && items[i - 1]!.at > d.at) i--
    items.splice(i, 0, { role: 'assistant', text, at: d.at, delivery: true })
  }
  const out: CallMessage[] = []
  let prev: Item | null = null
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && prev && !prev.delivery && !it.delivery && last.role === it.role) last.content += ' ' + it.text
    else out.push({ role: it.role, content: it.text })
    prev = it
  }
  return out
}

const CONTEXT_MESSAGES = 12
const CONTEXT_MESSAGE_CHARS = 400
const CONTEXT_CHARS = 2500

/** The conversation's latest messages as plain lines, for the call's models. */
export function chatContextFor(messages: Pick<MessageRow, 'role' | 'content'>[]): string {
  const lines = messages
    .filter((m) => m.content.trim())
    .slice(-CONTEXT_MESSAGES)
    .map((m) => {
      const text = m.content.replace(/\s+/g, ' ').trim()
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text.length > CONTEXT_MESSAGE_CHARS ? text.slice(0, CONTEXT_MESSAGE_CHARS) + '...' : text}`
    })
  let text = lines.join('\n')
  if (text.length > CONTEXT_CHARS) text = '...' + text.slice(text.length - CONTEXT_CHARS)
  return text
}

const NOTE_CHARS = 6000

/**
 * What the next typed turn is told about a call it has not heard of: the
 * voice messages added since the previous typed message. `messages` ends with
 * the turn's own message. Empty when there was no call in between.
 */
export function voiceNoteFor(messages: Pick<MessageRow, 'role' | 'content' | 'voice'>[]): string {
  const typedUser: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'user' && !m.voice) typedUser.push(i)
  })
  const cur = typedUser.length ? typedUser[typedUser.length - 1]! : messages.length
  const prev = typedUser.length > 1 ? typedUser[typedUser.length - 2]! : -1
  const voice = messages.slice(prev + 1, cur).filter((m) => m.voice && m.content.trim())
  if (!voice.length) return ''
  let body = voice.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`).join('\n')
  if (body.length > NOTE_CHARS) body = '...' + body.slice(body.length - NOTE_CHARS)
  return `[Since the last typed message, this chat had a voice call. What was said on it, for context:]\n${body}\n[End of the voice call.]`
}

// ---------- calls in progress ----------

interface WebCall {
  sessionId: string
  chatId: string
  conversationId: string
  deliveries: Delivery[]
  finished: boolean
  added: number
  done: Promise<void>
  markDone: () => void
}

/** Calls started from the web, by OpenAI session id. Kept a minute after they end. */
const calls = new Map<string, WebCall>()
const KEEP_AFTER_END_MS = 60_000

export class VoiceChatError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

function fileCall(call: WebCall, ended: EndedCall): void {
  if (call.finished) return
  call.finished = true
  try {
    // A conversation deleted mid-call takes nothing.
    const conv = getConversation(call.chatId, call.conversationId)
    if (conv) {
      const msgs = callMessages(ended.turns, ended.startedAt.getTime(), call.deliveries)
      for (const m of msgs) addMessage(call.conversationId, m.role, m.content, [], [], Date.now(), 'voice')
      call.added = msgs.length
      // A chat that began with a call is named after what was said first, as a typed one is.
      const first = msgs.find((m) => m.role === 'user')
      if (!conv.title && first) updateConversation(call.chatId, call.conversationId, { title: first.content.replace(/\s+/g, ' ').slice(0, 60) })
    }
  } catch (err) {
    logger.error({ err, conversationId: call.conversationId }, 'voice call could not be added to the conversation')
  } finally {
    call.markDone()
    const t = setTimeout(() => {
      if (calls.get(call.sessionId) === call) calls.delete(call.sessionId)
    }, KEEP_AFTER_END_MS)
    t.unref?.()
  }
}

/** The open call in a conversation, if any. */
export function activeCallFor(chatId: string, conversationId: string): string | null {
  for (const c of calls.values()) if (!c.finished && c.chatId === chatId && c.conversationId === conversationId) return c.sessionId
  return null
}

/**
 * Start a call in a conversation. Resolves to the session id and the SDP
 * answer the browser needs, and nothing else from OpenAI's reply (it carries
 * the instructions, which hold the chat's messages).
 */
export async function startWebCall(input: { chatId: string; conversationId: string; sdp: string; voice?: string }): Promise<{ sessionId: string; sdp: string }> {
  const block = deps.block(input.chatId)
  if (block) throw new VoiceChatError(503, block)
  if (activeCallFor(input.chatId, input.conversationId)) throw new VoiceChatError(409, 'call_active')
  let markDone!: () => void
  const done = new Promise<void>((r) => (markDone = r))
  const call: WebCall = { sessionId: '', chatId: input.chatId, conversationId: input.conversationId, deliveries: [], finished: false, added: 0, done, markDone }
  const result = await deps.start({
    sdp: input.sdp,
    voice: input.voice,
    chatId: input.chatId,
    chatContext: chatContextFor(listMessages(input.conversationId)),
    async deliver(text) {
      // During the call it waits, to sit in the transcript where it was said.
      // After the call (a lookup that outlived it) it goes straight in.
      if (!call.finished) {
        call.deliveries.push({ at: Date.now(), text })
        return true
      }
      if (!getConversation(call.chatId, call.conversationId)) return false
      addMessage(call.conversationId, 'assistant', text, [], [], Date.now(), 'voice')
      return true
    },
    onEnded: (ended) => fileCall(call, ended),
  })
  const sessionId = result.session?.id
  const sdp = result.transport?.sdp
  if (!sessionId || !sdp) throw new VoiceChatError(502, 'no_session_id')
  call.sessionId = sessionId
  calls.set(sessionId, call)
  logger.info({ sessionId, conversationId: input.conversationId }, 'web voice call started')
  return { sessionId, sdp }
}

/**
 * End a call this chat started (a no-op on one already over), then wait up to
 * `waitMs` for its transcript to land. Null for an unknown call or another
 * chat's.
 */
export async function endWebCall(chatId: string, sessionId: string, waitMs = 0): Promise<{ finished: boolean; added: number } | null> {
  const call = calls.get(sessionId)
  if (!call || call.chatId !== chatId) return null
  if (!call.finished) deps.end(sessionId, chatId)
  if (waitMs > 0 && !call.finished) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([call.done, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))])
    clearTimeout(timer)
  }
  return { finished: call.finished, added: call.added }
}

/** End every call open in a conversation (it is being deleted). */
export function endCallsForConversation(chatId: string, conversationId: string): void {
  for (const c of calls.values()) {
    if (!c.finished && c.chatId === chatId && c.conversationId === conversationId) deps.end(c.sessionId, chatId)
  }
}
