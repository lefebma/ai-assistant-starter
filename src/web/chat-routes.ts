/** Web chat routes: conversations, the streaming chat turn, cancel, and message files. */
import { createReadStream, statSync } from 'node:fs'
import { extname, relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { UPLOADS_DIR } from '../media.js'
import { logger } from '../logger.js'
import { runWebTurn, cancelWebTurn, extractButtons, runWebCommand, COMMAND_MENU } from '../bot.js'
import { extractFileMarkers, resolveOutboundFile } from '../outbound-files.js'
import { resolveVisible } from './files.js'
import { projectFraming } from './projects.js'
import { registerWebRoutes, type WebContext } from './http.js'
import { sendJson, sendError, readJsonCapped, openSse, BodyError } from './respond.js'
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

const MODELS = ['', 'haiku', 'sonnet', 'opus']
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh']
const MAX_TEXT = 100_000
const MAX_TITLE = 120
/** Room for the text plus pasted text (card #249); uploads go through the upload route. */
const MAX_CHAT_BODY = 2 * 1024 * 1024

/** Conversations with a turn in flight. Added on start, removed when the turn settles. */
const running = new Set<string>()

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
      deleteConversation(ctx.chatId, id)
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
      sendJson(ctx.res, 200, { conversation: convJson(conv), messages: listMessages(id).map(msgJson) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/conversations\/([^/]+)\/cancel$/,
    auth: true,
    async handler(ctx) {
      const id = ctx.params[0]!
      if (!getConversation(ctx.chatId, id)) return sendError(ctx.res, 404, 'not_found')
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
      if (running.has(id)) return sendError(ctx.res, 409, 'busy')
      // A click answers the latest reply's card once. A stale tab, a second
      // click, or a label that card does not offer is refused.
      const clicked = buttonClickLabel(text)
      const clickedMessageId = clicked !== null ? latestAssistantMessageId(id) : undefined
      if (clicked !== null && !claimButtonClick(id, clicked)) return sendError(ctx.res, 409, 'buttons_used')

      running.add(id)
      try {
        let attached: Attached[] = []
        try {
          attached = commitAttachments(id, planned.plan)
        } catch (err) {
          logger.error({ err, conversationId: id }, 'web chat attachments could not be saved')
          return sendError(ctx.res, 500, 'attachments_failed')
        }
        const sse = openSse(ctx.res, { heartbeatMs: 15_000 })
        // Deliberately no cancel on close: the turn finishes and is stored.

        // The owner's message is stored once something answers it, so a key
        // pasted for /secret (which the command deletes) never reaches history.
        let userStored = false
        let userDropped = false
        const storeUser = () => {
          if (userStored || userDropped) return
          userStored = true
          addMessage(id, 'user', text, attached.map(toStored))
          if (!conv.title) updateConversation(ctx.chatId, id, { title: text ? text.replace(/\s+/g, ' ').slice(0, 60) : attachmentTitle(attached) })
        }
        const stored = (mid: number) => msgJson(listMessages(id).find((m) => m.id === mid)!)
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
          const current = getConversation(ctx.chatId, id) ?? conv
          let sent = ''
          const result = await runWebTurn({
            chatId: ctx.chatId,
            conversationId: id,
            text: turnText,
            framing: framingFor(current.projectId),
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
          if (result.newSessionId) updateConversation(ctx.chatId, id, { sessionId: result.newSessionId })
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
        // A message with attachments is never a command (checked above).
        if (!attaching) try {
          const cmd = await runWebCommand({
            chatId: ctx.chatId,
            conversationId: id,
            text,
            clickedMessageId,
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
                  else if (r.kind === 'paused') sse.writeEvent('reply', { message: stored(latestAssistantMessageId(id)!) })
                  else reply('*Stopped.*')
                } catch (err) {
                  logger.error({ err, conversationId: id }, 'web command turn failed')
                  reply(ownerMessage(err))
                }
              },
            },
          })
          if (cmd.handled) {
            storeUser()
            if (cmd.clearSession) updateConversation(ctx.chatId, id, { sessionId: '' })
            sse.writeEvent('done', { cancelled: false, command: true })
            sse.close()
            return
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
          if (r.kind === 'paused') sse.writeEvent('paused', { text: r.text })
          else if (r.kind === 'cancelled') sse.writeEvent('done', { cancelled: true })
          else sse.writeEvent('done', { cancelled: false, message: stored(r.mid) })
        } catch (err) {
          logger.error({ err, conversationId: id }, 'web chat turn failed')
          sse.writeEvent('error', { message: ownerMessage(err) })
        }
        sse.close()
      } finally {
        running.delete(id)
      }
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
