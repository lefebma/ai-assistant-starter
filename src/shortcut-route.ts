/**
 * POST /api/shortcut: a question from an Apple Shortcut, answered in the body
 * (card #152).
 *
 * The contract is deliberately the dullest one Shortcuts can speak: a bearer
 * header, a JSON body with one `text` field (or the question as a plain-text
 * body), and plain text back. Plain text because that is what "Show Result"
 * displays and Siri reads aloud without any parsing step for a non-technical
 * owner to get wrong.
 *
 * Apple gives up on a request at around 25 seconds and cannot be asked to wait
 * longer, and an agent turn that touches a tool regularly takes longer than
 * that. So the request is held for SHORTCUT_WAIT_SECONDS and then answered
 * with "still working", and the real answer goes to the chat when it lands.
 * The same happens if the phone hangs up first. Nothing asked from a Shortcut
 * is dropped because the phone stopped listening.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extractFileMarkers } from './outbound-files.js'
import { logger } from './logger.js'

export const MAX_SHORTCUT_BODY_BYTES = 64 * 1024
export const MAX_SHORTCUT_CHARS = 8000

const BUTTONS_RE = /\[\[buttons:\s*[^\]]*\]\]/gi

export interface ShortcutDeps {
  resolveToken(token: string): string | null
  isChatAllowed(chatId: string): boolean
  isChatBusy(chatId: string): boolean
  runTurn(chatId: string, text: string): Promise<string | null>
  /** Text plus any [[file:]] it carries, into the chat. False when there is no chat to send to. */
  deliverToChat(chatId: string, text: string): Promise<boolean>
  waitMs: number
}

export type ShortcutReply = { status: number; body: string }

/**
 * What the phone should see for a finished reply, and what (if anything) has
 * to go to the chat because a Shortcut cannot carry it.
 *
 * A file cannot ride back in a text body, and a button cannot be pressed in a
 * result panel. Either one sends the reply to the chat as well, and the phone
 * is told where to look. The framing asks the model for neither, so this is
 * the fallback for when it does it anyway, not the expected path.
 */
export function shapeShortcutReply(reply: string): { phone: string; toChat: string | null } {
  const hadButtons = BUTTONS_RE.test(reply)
  BUTTONS_RE.lastIndex = 0
  const withoutButtons = reply.replace(BUTTONS_RE, '').trim()
  const { cleanText, requests } = extractFileMarkers(withoutButtons)
  const notes: string[] = []
  if (requests.length > 0) notes.push(requests.length > 1 ? 'I sent the files to your chat.' : 'I sent the file to your chat.')
  if (hadButtons) notes.push('This needs your OK, so it is in your chat too. Answer there.')
  const phone = [cleanText.trim(), ...notes].filter(Boolean).join('\n\n') || 'Done.'
  const toChat = requests.length > 0 || hadButtons ? withoutButtons : null
  return { phone, toChat }
}

/** The question out of a JSON `{ "text": ... }` body or a plain-text one. */
export function parseShortcutBody(raw: string, contentType: string | undefined): string | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const looksJson = type === 'application/json' || raw.trimStart().startsWith('{')
  if (looksJson) {
    try {
      const parsed = JSON.parse(raw) as { text?: unknown }
      return typeof parsed.text === 'string' ? parsed.text.trim() : null
    } catch {
      return type === 'application/json' ? null : raw.trim()
    }
  }
  return raw.trim()
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? ''
  return /^bearer /i.test(h) ? h.slice(7).trim() : ''
}

function readCapped(req: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) over = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, reply: ShortcutReply): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(reply.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(reply.body)
}

/** How the chat is told what a late answer was answering. */
export function lateAnswerMessage(question: string, answer: string): string {
  const q = question.length > 120 ? question.slice(0, 117) + '...' : question
  return `From your shortcut: "${q}"\n\n${answer}`
}

export async function handleShortcut(req: IncomingMessage, res: ServerResponse, deps: ShortcutDeps): Promise<void> {
  const chatId = deps.resolveToken(bearer(req))
  if (!chatId) {
    send(res, { status: 401, body: 'This shortcut\'s key is not valid any more. Send /shortcut in your chat to get a new one.' })
    return
  }
  if (!deps.isChatAllowed(chatId)) {
    send(res, { status: 403, body: 'This chat no longer has access to the assistant.' })
    return
  }

  const raw = await readCapped(req, MAX_SHORTCUT_BODY_BYTES)
  if (raw === null) {
    send(res, { status: 413, body: 'That is too long for a shortcut. Send it in the chat instead.' })
    return
  }
  const question = parseShortcutBody(raw, req.headers['content-type'])
  if (question === null) {
    send(res, { status: 400, body: 'The shortcut sent something I could not read. Its request body should be JSON with a text field.' })
    return
  }
  if (!question) {
    send(res, { status: 400, body: 'Nothing to ask. Say or type a question.' })
    return
  }
  if (question.length > MAX_SHORTCUT_CHARS) {
    send(res, { status: 413, body: 'That is too long for a shortcut. Send it in the chat instead.' })
    return
  }
  if (deps.isChatBusy(chatId)) {
    send(res, { status: 409, body: 'I am in the middle of something in your chat. Try again in a minute.' })
    return
  }

  // Whoever finishes first owns the reply: the turn, the clock, or the phone
  // hanging up. Once the phone has been answered (or has gone), the answer
  // belongs to the chat.
  let handedOff = false
  const handOff = (reason: string): void => {
    if (handedOff) return
    handedOff = true
    logger.info({ chatId, reason }, 'shortcut answer handed to the chat')
    send(res, { status: 202, body: 'Still working on that. I will send the answer to your chat.' })
  }
  const timer = setTimeout(() => handOff('wait budget spent'), deps.waitMs)
  res.on('close', () => {
    if (!res.writableEnded) handOff('client hung up')
  })

  let reply: string | null
  try {
    reply = await deps.runTurn(chatId, question)
  } catch (err) {
    clearTimeout(timer)
    logger.error({ err, chatId }, 'shortcut turn failed')
    if (handedOff) {
      await deps.deliverToChat(chatId, lateAnswerMessage(question, 'That one failed on my side. Ask again here.')).catch(() => {})
    } else {
      handedOff = true
      send(res, { status: 500, body: 'Something went wrong on my side. Try again, or ask in the chat.' })
    }
    return
  }
  clearTimeout(timer)
  const text = reply?.trim() ? reply : 'I had nothing to say to that.'

  if (handedOff) {
    const ok = await deps.deliverToChat(chatId, lateAnswerMessage(question, text)).catch((err: unknown) => {
      logger.error({ err, chatId }, 'delivering a late shortcut answer failed')
      return false
    })
    if (!ok) logger.warn({ chatId }, 'late shortcut answer had nowhere to go')
    return
  }

  handedOff = true
  const shaped = shapeShortcutReply(text)
  send(res, { status: 200, body: shaped.phone })
  if (shaped.toChat) {
    await deps.deliverToChat(chatId, lateAnswerMessage(question, shaped.toChat)).catch((err: unknown) => {
      logger.error({ err, chatId }, 'sending a shortcut reply to the chat failed')
    })
  }
}
