/** Web chat routes: conversations, the streaming chat turn, the queue of waiting messages, cancel, and message files. */
import { createReadStream, statSync } from 'node:fs'
import { extname, relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { UPLOADS_DIR } from '../media.js'
import { logger } from '../logger.js'
import { runWebTurn, cancelWebTurn, webSecretAwaited, webSupportAwaited, extractButtons, runWebCommand, COMMAND_MENU } from '../bot.js'
import { extractFileMarkers, resolveOutboundFile } from '../outbound-files.js'
import { resolveVisible } from './files.js'
import { projectFraming } from './projects.js'
import { registerWebRoutes, type WebContext } from './http.js'
import { sendJson, sendError, readJsonCapped, openSse, BodyError } from './respond.js'
import { voiceNoteFor, endCallsForConversation } from './voice-chat.js'
import { attachmentTitle, attachmentTurnText, commitAttachments, planAttachments, removeConversationFiles, toStored, type Attached } from './attachments.js'
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  addMessage,
  listMessages,
  getMessageForChat,
  buttonClickLabel,
  claimButtonClick,
  setMessageContent,
  markButtonsUsed,
  latestAssistantMessageId,
  type ConversationRow,
  type MessageRow,
  type StoredFile,
} from './conversations.js'
import {
  addItem,
  getItem,
  findByClientId,
  listQueued,
  hasQueued,
  claimNext,
  finishItem,
  settleStale,
  editQueued,
  removeQueued,
  deleteQueueForConversation,
  itemJson,
  hubBegin,
  hubWrite,
  hubEnd,
  hubIdle,
  hubSubscribe,
  TURN_END,
  IDLE,
  type QueueItem,
} from './queue.js'

const MODELS = ['', 'haiku', 'sonnet', 'opus']
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh']
const MAX_TEXT = 100_000
const MAX_TITLE = 120
/** Room for the text plus pasted text (card #249); uploads go through the upload route. */
const MAX_CHAT_BODY = 2 * 1024 * 1024

/** Conversations with a turn in flight. Added on start, removed when the turn settles. */
const running = new Set<string>()
/** The message each conversation's turn in flight is answering, so Stop can name the one it means. */
const runningItem = new Map<string, QueueItem>()

const framingFor = (projectId: string): string => projectFraming(projectId)

const convJson = (c: ConversationRow) => ({
  id: c.id,
  projectId: c.projectId,
  title: c.title,
  model: c.model,
  effort: c.effort,
  updatedAt: c.updatedAt,
})

const msgJson = (m: MessageRow) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  files: m.files.map((f, index) => ({ index, name: f.name, kind: f.kind, ...(f.pasted ? { pasted: true } : {}) })),
  buttons: m.buttons,
  buttonsUsed: m.buttonsUsed,
  ...(m.voice ? { voice: true } : {}),
  createdAt: m.createdAt,
})

async function jsonBody(ctx: WebContext, max?: number): Promise<Record<string, unknown>> {
  const parsed = await readJsonCapped(ctx.req, max)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError(400, 'bad_json')
  return parsed as Record<string, unknown>
}

/** A plain-language reason for the owner; never a stack. */
function ownerMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : ''
  if (m && m.length <= 200 && !/\n|\bat .*\(|node_modules/.test(m)) return m
  return 'Something went wrong while answering. Please try again.'
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const OTHER_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file'
}


/**
 * A file the chat may hand over must also be one the file panel shows: the
 * panel's hidden list (store, logs, keys, code...) is the boundary, so the
 * assistant cannot send what the owner could not open there.
 */
function panelVisible(abs: string): boolean {
  let root: string
  try {
    root = realpathSync(PROJECT_ROOT)
  } catch {
    return false
  }
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return false
  const v = resolveVisible(rel.split('\\').join('/'))
  return !!v && !v.isDir
}

/**
 * Commands that act on the reply in progress run at once, even mid-turn, as
 * they do in Telegram. So does /secret (it may carry a key inline), and so
 * does the key a pending /secret set waits for: neither is ever written to
 * the queue. The answer a pending /support waits for runs at once too (see
 * the chat route). Every other message sent mid-turn waits its turn.
 */
const RUNS_NOW = /^\/(cancel|steer|secret)(?:@\S+)?(?:\s|$)/i

/** Where a message's answer goes: the conversation's hub, or one response. */
interface Sink {
  writeEvent(name: string, data: unknown): void
  close(): void
}

const ATTACH_NOTES: Record<string, string> = {
  attachment_missing: 'An attachment is no longer on the box, so that message was not sent. Attach it again and send it.',
}

/**
 * Answer one message: slash commands and the flows they start the way
 * Telegram does, anything else as an agent turn. The owner's message is
 * stored once something answers it, and announced as a `user` event so a
 * page following along can show it. 'paused' when the AI limit was reached.
 */
async function answer(
  chatId: string,
  conv: ConversationRow,
  text: string,
  attached: Attached[],
  clickedMessageId: number | undefined,
  sse: Sink,
  fromQueue = false,
): Promise<'paused' | void> {
  const id = conv.id
  const attaching = attached.length > 0
  // The owner's message is stored once something answers it, so a key
  // pasted for /secret (which the command deletes) never reaches history.
  let userStored = false
  let userDropped = false
  const stored = (mid: number) => msgJson(listMessages(id).find((m) => m.id === mid)!)
  const storeUser = () => {
    if (userStored || userDropped) return
    userStored = true
    const mid = addMessage(id, 'user', text, attached.map(toStored))
    sse.writeEvent('user', { message: stored(mid) })
    if (!conv.title) updateConversation(chatId, id, { title: text ? text.replace(/\s+/g, ' ').slice(0, 60) : attachmentTitle(attached) })
  }
  const reply = (content: string, files: StoredFile[] = [], buttons: string[] = []): number => {
    storeUser()
    const mid = addMessage(id, 'assistant', content, files, buttons)
    sse.writeEvent('reply', { message: stored(mid) })
    return mid
  }

  /** One agent turn on this conversation's session, streamed to the page. */
  const agentTurn = async (turnText: string, skipMemory = false): Promise<
    { kind: 'reply'; mid: number } | { kind: 'paused'; text: string } | { kind: 'cancelled' }
  > => {
    // Read the session now: /newchat may have just cleared it.
    const current = getConversation(chatId, id) ?? conv
    let sent = ''
    // A voice call since the last typed message happened outside this
    // session: tell it what was said. Framing, so memory does not save it twice.
    const voiceNote = voiceNoteFor(listMessages(id))
    const result = await runWebTurn({
      chatId,
      conversationId: id,
      text: turnText,
      framing: [framingFor(current.projectId), voiceNote].filter(Boolean).join('\n\n'),
      sessionId: current.sessionId || undefined,
      model: current.model || undefined,
      effort: (current.effort || undefined) as 'low' | 'medium' | 'high' | 'xhigh' | undefined,
      skipMemory,
      onQueued: (ahead) => sse.writeEvent('queued', { ahead }),
      onPartial: (acc) => {
        // A runtime retry restarts the text from scratch. Appending it
        // would show both attempts, so the page is told to replace.
        if (!acc.startsWith(sent)) {
          sent = acc
          sse.writeEvent('reset', { text: acc })
          return
        }
        const delta = acc.slice(sent.length)
        sent = acc
        if (delta) sse.writeEvent('delta', { text: delta })
      },
      onToolProgress: (tool, status) => sse.writeEvent('tool', { tool, status }),
    })
    if (result.newSessionId) updateConversation(chatId, id, { sessionId: result.newSessionId })
    if (result.paused) {
      addMessage(id, 'assistant', result.paused)
      return { kind: 'paused', text: result.paused }
    }
    if (result.cancelled || result.text === null) return { kind: 'cancelled' }
    const { cleanText: noFiles, requests } = extractFileMarkers(result.text)
    const { cleanText, labels } = extractButtons(noFiles)
    const files: StoredFile[] = []
    const notes: string[] = []
    for (const req of requests) {
      const r = resolveOutboundFile(req.requested, { projectRoot: PROJECT_ROOT, uploadsDir: UPLOADS_DIR })
      if (r.ok && !panelVisible(r.path)) notes.push('(file not sent: it is in a part of the box the web app keeps hidden)')
      else if (r.ok) files.push({ path: r.path, name: r.name, kind: r.kind })
      else notes.push(`(file not sent: ${r.reason})`)
    }
    const content = [cleanText, ...notes].filter(Boolean).join('\n\n')
    return { kind: 'reply', mid: addMessage(id, 'assistant', content, files, labels) }
  }

  // Slash commands, and the flows they start, answer the same way they
  // do in Telegram. Anything they do not own goes to the agent below.
  // A message with attachments is never a command (checked on send).
  let paused = false
  if (!attaching) try {
    const cmd = await runWebCommand({
      chatId,
      conversationId: id,
      text,
      clickedMessageId,
      fromQueue,
      hooks: {
        send: (t, buttons) => String(reply(t, [], buttons)),
        edit: (mid, t) => setMessageContent(id, Number(mid), t),
        clearButtons: (mid) => markButtonsUsed(id, Number(mid)),
        dropUserMessage: () => {
          userDropped = true
          sse.writeEvent('dropped', {})
        },
        file: (path, kind) => {
          if (kind === 'voice') return // the web has no voice replies
          const r = resolveOutboundFile(path, { projectRoot: PROJECT_ROOT, uploadsDir: UPLOADS_DIR })
          if (r.ok && panelVisible(r.path)) reply('', [{ path: r.path, name: r.name, kind: r.kind }])
          else reply('(file not sent: it is in a part of the box the web app keeps hidden)')
        },
        turn: async (t, opts) => {
          storeUser()
          try {
            const r = await agentTurn(t, opts.skipMemory)
            if (r.kind === 'reply') sse.writeEvent('reply', { message: stored(r.mid) })
            else if (r.kind === 'paused') {
              paused = true
              sse.writeEvent('reply', { message: stored(latestAssistantMessageId(id)!) })
            } else reply('*Stopped.*')
          } catch (err) {
            logger.error({ err, conversationId: id }, 'web command turn failed')
            reply(ownerMessage(err))
          }
        },
      },
    })
    if (cmd.handled) {
      storeUser()
      if (cmd.clearSession) updateConversation(chatId, id, { sessionId: '' })
      sse.writeEvent('done', { cancelled: false, command: true })
      sse.close()
      return paused ? 'paused' : undefined
    }
  } catch (err) {
    // The owner's message stays unstored: a command that failed half way
    // through a /secret set may have been holding a key.
    logger.error({ err, conversationId: id }, 'web chat command failed')
    sse.writeEvent('error', { message: ownerMessage(err) })
    sse.close()
    return
  }
  storeUser()

  try {
    const r = await agentTurn(attachmentTurnText(text, attached))
    if (r.kind === 'paused') {
      sse.writeEvent('paused', { text: r.text })
      paused = true
    } else if (r.kind === 'cancelled') sse.writeEvent('done', { cancelled: true })
    else sse.writeEvent('done', { cancelled: false, message: stored(r.mid) })
  } catch (err) {
    logger.error({ err, conversationId: id }, 'web chat turn failed')
    sse.writeEvent('error', { message: ownerMessage(err) })
  }
  sse.close()
  return paused ? 'paused' : undefined
}

/**
 * Run one message's turn through the conversation's hub, then start the next
 * waiting one. The caller has already put the conversation in `running`.
 * `attached` is null for a message that waited: its uploads are moved now.
 * `onBegin` runs just before the turn is announced, so the sender hears it all.
 * After the AI limit pauses a turn, the queue waits: it starts again when the
 * owner sends something or a page follows the chat.
 */
async function runTurn(chatId: string, conv: ConversationRow, item: QueueItem, attached: Attached[] | null, onBegin?: () => void): Promise<void> {
  const id = conv.id
  // A message that waited was sent before anything that came after it, such
  // as a /secret set now waiting for its key, so it is never that key.
  const waited = attached === null
  runningItem.set(id, item)
  // The sender listens first, so its stream names the message too (Stop uses it).
  onBegin?.()
  hubBegin(id, item)
  const sink: Sink = { writeEvent: (n, d) => hubWrite(id, n, d), close: () => {} }
  let held = false
  try {
    if (!attached) {
      const planned = planAttachments(item.attachments, item.pastes)
      if (!planned.ok) {
        sink.writeEvent('error', { message: ATTACH_NOTES[planned.code] ?? 'An attachment could not be sent. Attach it again and send it.' })
        return
      }
      attached = commitAttachments(id, planned.plan)
    }
    held = (await answer(chatId, conv, item.text, attached, item.clickedMessageId ?? undefined, sink, waited)) === 'paused'
  } catch (err) {
    logger.error({ err, conversationId: id }, 'web chat queued turn failed')
    sink.writeEvent('error', { message: ownerMessage(err) })
  } finally {
    try {
      finishItem(item.id)
    } catch (err) {
      logger.error({ err, conversationId: id }, 'web chat queue row could not be finished')
    }
    running.delete(id)
    runningItem.delete(id)
    hubEnd(id)
    try {
      if (held) hubIdle(id)
      else startNext(chatId, id)
    } catch (err) {
      // Nothing restarts the queue until a page follows the chat or sends.
      logger.error({ err, conversationId: id }, 'web chat queue could not start the next message')
      hubIdle(id)
    }
  }
}

/** Start the oldest waiting message, if nothing is running. Tells followers when there is none. */
function startNext(chatId: string, id: string): void {
  if (running.has(id)) return
  const conv = getConversation(chatId, id)
  if (!conv) {
    deleteQueueForConversation(id)
    hubIdle(id)
    return
  }
  const next = claimNext(id)
  if (!next) {
    hubIdle(id)
    return
  }
  running.add(id)
  void runTurn(chatId, conv, next, null)
}

const queueRoute = (rest: string) => new RegExp('^/api/web/conversations/([^/]+)/queue/(\\d+)' + rest + '$')

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/commands$/,
    auth: true,
    handler(ctx) {
      sendJson(ctx.res, 200, { commands: COMMAND_MENU })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/conversations$/,
    auth: true,
    handler(ctx) {
      const project = ctx.url.searchParams.get('project')
      const rows = listConversations(ctx.chatId, project === null ? undefined : project)
      sendJson(ctx.res, 200, { conversations: rows.map(convJson) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations$/,
    auth: true,
    async handler(ctx) {
      const b = await jsonBody(ctx)
      const projectId = typeof b.projectId === 'string' ? b.projectId.slice(0, 100) : ''
      sendJson(ctx.res, 200, { conversation: convJson(createConversation(ctx.chatId, projectId)) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      const b = await jsonBody(ctx)
      const patch: { title?: string; model?: string; effort?: string } = {}
      if (b.title !== undefined) {
        if (typeof b.title !== 'string') return sendError(ctx.res, 400, 'bad_request')
        patch.title = b.title.trim().slice(0, MAX_TITLE)
      }
      if (b.model !== undefined) {
        if (typeof b.model !== 'string' || !MODELS.includes(b.model)) return sendError(ctx.res, 400, 'bad_model')
        patch.model = b.model
      }
      if (b.effort !== undefined) {
        if (typeof b.effort !== 'string' || !EFFORTS.includes(b.effort)) return sendError(ctx.res, 400, 'bad_effort')
        patch.effort = b.effort
      }
      updateConversation(ctx.chatId, id, patch)
      sendJson(ctx.res, 200, { conversation: convJson(getConversation(ctx.chatId, id)!) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/delete$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      if (running.has(id)) cancelWebTurn(id)
      endCallsForConversation(ctx.chatId, id)
      deleteConversation(ctx.chatId, id)
      deleteQueueForConversation(id)
      removeConversationFiles(id)
      sendJson(ctx.res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/messages$/,
    auth: true,
    handler(ctx) {
      const id = ctx.params[0]!
      const conv = getConversation(ctx.chatId, id)
      if (!conv) return sendError(ctx.res, 404, 'not_found')
      settleStale(id, running.has(id))
      sendJson(ctx.res, 200, {
        conversation: convJson(conv),
        messages: listMessages(id).map(msgJson),
        // Waiting messages, oldest first, and whether a reply is in progress.
        queue: listQueued(id).map(itemJson),
        running: running.has(id),
      })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/cancel$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      // The page names the message whose reply it means to stop. If that one
      // has already finished and the next waiting message has just started,
      // nothing is stopped: Stop never takes the next message by mistake.
      const b = await jsonBody(ctx).catch(() => ({}) as Record<string, unknown>)
      const itemId = typeof b.itemId === 'number' ? b.itemId : null
      const clientId = typeof b.clientId === 'string' && b.clientId ? b.clientId : null
      if (itemId !== null || clientId !== null) {
        const cur = runningItem.get(id)
        const same = !!cur && (itemId !== null ? cur.id === itemId : cur.clientId === clientId)
        if (!same) return sendJson(ctx.res, 200, { stopped: false, reason: 'finished' })
      }
      const r = cancelWebTurn(id)
      sendJson(ctx.res, 200, { stopped: Boolean(r.stoppedActive || r.droppedQueued) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/chat$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      const conv = getConversation(ctx.chatId, id)
      if (!conv) return sendError(ctx.res, 404, 'not_found')
      const b = await jsonBody(ctx, MAX_CHAT_BODY)
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (text.length > MAX_TEXT) return sendError(ctx.res, 400, 'bad_text')
      const planned = planAttachments(b.attachments, b.pastes)
      if (!planned.ok) return sendError(ctx.res, 400, planned.code)
      const attaching = planned.plan.uploads.length + planned.plan.pastes.length > 0
      if (!text && !attaching) return sendError(ctx.res, 400, 'bad_text')
      // A command or a button answer takes no attachments: it would drop them.
      if (attaching && (text.startsWith('/') || buttonClickLabel(text) !== null)) return sendError(ctx.res, 400, 'attachments_with_command')

      // A retried send (a dropped connection, a double press) finds the
      // message it already made instead of sending it again.
      const clientId = typeof b.clientId === 'string' ? b.clientId.slice(0, 100) : ''
      const earlier = findByClientId(id, clientId)
      if (earlier) return sendJson(ctx.res, 202, { item: itemJson(earlier) })

      settleStale(id, running.has(id))
      const busy = running.has(id) || hasQueued(id)
      const secretKey = !text.startsWith('/') && webSecretAwaited(ctx.chatId)
      // The answer a pending /support waits for also runs at once: a message
      // that waited is never taken as that answer, so this one must not wait.
      // A click is never that answer; it waits like any other message.
      const supportAnswer = !attaching && buttonClickLabel(text) === null && webSupportAwaited(ctx.chatId, text)
      if (busy && (RUNS_NOW.test(text) || secretKey || supportAnswer)) {
        let attached: Attached[] = []
        try {
          attached = commitAttachments(id, planned.plan)
        } catch (err) {
          logger.error({ err, conversationId: id }, 'web chat attachments could not be saved')
          return sendError(ctx.res, 500, 'attachments_failed')
        }
        // Remember the send by its clientId only, never its words, so a
        // retry (the answer got lost on the way back) is not sent again,
        // and above all is not queued as a plain message.
        if (clientId) addItem({ conversationId: id, chatId: ctx.chatId, clientId, text: '', attachments: [], pastes: [], state: 'done' })
        const sse = openSse(ctx.res, { heartbeatMs: 15_000 })
        await answer(ctx.chatId, conv, text, attached, undefined, sse)
        return
      }
      // A click answers the latest reply's card once. A stale tab, a second
      // click, or a label that card does not offer is refused. A click made
      // mid-turn claims the card now and waits like any other message.
      const clicked = buttonClickLabel(text)
      const clickedMessageId = clicked !== null ? latestAssistantMessageId(id) : undefined
      if (clicked !== null && !claimButtonClick(id, clicked)) return sendError(ctx.res, 409, 'buttons_used')

      const row = {
        conversationId: id,
        chatId: ctx.chatId,
        clientId,
        text,
        attachments: (Array.isArray(b.attachments) ? b.attachments : []) as string[],
        pastes: planned.plan.pastes,
        clickedMessageId: clickedMessageId ?? null,
      }
      if (busy) {
        // Waits behind the reply in progress. Its uploads stay where they
        // are until it starts. A queue a restart left waiting starts now.
        const item = addItem({ ...row, state: 'queued' })
        startNext(ctx.chatId, id)
        return sendJson(ctx.res, 202, { item: itemJson(getItem(id, item.id) ?? item) })
      }

      running.add(id)
      let attached: Attached[] = []
      try {
        attached = commitAttachments(id, planned.plan)
      } catch (err) {
        running.delete(id)
        logger.error({ err, conversationId: id }, 'web chat attachments could not be saved')
        return sendError(ctx.res, 500, 'attachments_failed')
      }
      const item = addItem({ ...row, state: 'running' })
      const sse = openSse(ctx.res, { heartbeatMs: 15_000 })
      // Deliberately no cancel on close: the turn finishes and is stored.
      let off = () => {}
      await runTurn(ctx.chatId, conv, item, attached, () => {
        off = hubSubscribe(
          id,
          (name, data) => {
            if (name === TURN_END) {
              off()
              sse.close()
            } else if (name !== IDLE) sse.writeEvent(name, data)
          },
          false,
        )
      })
      off()
      sse.close()
    },
  },
  {
    // Follow a conversation: the turn in progress (what it has said so far,
    // then live), then each waiting message as it starts, until nothing is
    // left. A reloaded page, or one whose connection dropped, reattaches here.
    method: 'GET',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/stream$/,
    auth: true,
    handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      settleStale(id, running.has(id))
      const sse = openSse(ctx.res, { heartbeatMs: 15_000 })
      // A queue a restart left waiting starts once someone is watching.
      if (!running.has(id)) startNext(ctx.chatId, id)
      if (!running.has(id)) {
        sse.writeEvent('idle', {})
        sse.close()
        return
      }
      const off = hubSubscribe(id, (name, data) => {
        if (name === IDLE) {
          sse.writeEvent('idle', {})
          sse.close()
        } else if (name !== TURN_END) sse.writeEvent(name, data)
      })
      sse.onClose(off)
    },
  },
  {
    // Change a waiting message's text. Refused once it has started.
    method: 'POST',
    pattern: queueRoute(''),
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      const qid = Number(ctx.params[1])
      const item = getItem(id, qid)
      if (!item) return sendError(ctx.res, 404, 'not_found')
      const b = await jsonBody(ctx)
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      const attaching = item.attachments.length + item.pastes.length > 0
      if (text.length > MAX_TEXT || (!text && !attaching)) return sendError(ctx.res, 400, 'bad_text')
      // A click claimed its card when it was sent; it is not text to rewrite.
      if (buttonClickLabel(item.text) !== null || buttonClickLabel(text) !== null) return sendError(ctx.res, 400, 'bad_text')
      if (attaching && text.startsWith('/')) return sendError(ctx.res, 400, 'attachments_with_command')
      // What would run at once (/cancel, /steer, /secret, or the key a
      // /secret set waits for) is never written into a waiting message.
      if (RUNS_NOW.test(text) || (!text.startsWith('/') && webSecretAwaited(ctx.chatId))) return sendError(ctx.res, 400, 'runs_now')
      const r = editQueued(id, qid, text)
      if (r === 'started') return sendError(ctx.res, 409, 'started')
      if (r === 'missing') return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, { item: itemJson(getItem(id, qid)!) })
    },
  },
  {
    // Take a waiting message off the queue. Refused once it has started.
    method: 'POST',
    pattern: queueRoute('/delete'),
    auth: true,
    handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
      const r = removeQueued(id, Number(ctx.params[1]))
      if (r === 'started') return sendError(ctx.res, 409, 'started')
      if (r === 'missing') return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/messages\/(\d+)\/files\/(\d+)$/,
    auth: true,
    handler(ctx) {
      const msg = getMessageForChat(ctx.chatId, Number(ctx.params[0]))
      const file = msg?.files[Number(ctx.params[1])]
      if (!msg || !file) return sendError(ctx.res, 404, 'not_found')
      const r = resolveOutboundFile(file.path, { projectRoot: PROJECT_ROOT, uploadsDir: UPLOADS_DIR })
      if (!r.ok || !panelVisible(r.path)) return sendError(ctx.res, 404, 'not_found')
      let size: number
      try {
        size = statSync(r.path).size
      } catch {
        return sendError(ctx.res, 404, 'not_found')
      }
      const ext = extname(r.name).toLowerCase()
      const inline = ext in IMAGE_MIME || ext === '.pdf'
      const type = IMAGE_MIME[ext] ?? OTHER_MIME[ext] ?? 'application/octet-stream'
      ctx.res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(r.name)}"`,
      })
      const stream = createReadStream(r.path)
      stream.on('error', () => ctx.res.destroy())
      stream.pipe(ctx.res)
    },
  },
])
