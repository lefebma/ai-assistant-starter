/** Web chat routes: conversations, the streaming chat turn, cancel, and message files. */
import { createReadStream, statSync } from 'node:fs'
import { extname, relative } from 'node:path'
import { realpathSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { UPLOADS_DIR } from '../media.js'
import { logger } from '../logger.js'
import { runWebTurn, cancelWebTurn, extractButtons } from '../bot.js'
import { extractFileMarkers, resolveOutboundFile } from '../outbound-files.js'
import { resolveVisible } from './files.js'
import { projectFraming } from './projects.js'
import { registerWebRoutes, type WebContext } from './http.js'
import { sendJson, sendError, readJsonCapped, openSse, BodyError } from './respond.js'
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
  type ConversationRow,
  type MessageRow,
  type StoredFile,
} from './conversations.js'

const MODELS = ['', 'haiku', 'sonnet', 'opus']
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh']
const MAX_TEXT = 100_000
const MAX_TITLE = 120

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
  files: m.files.map((f, index) => ({ index, name: f.name, kind: f.kind })),
  buttons: m.buttons,
  buttonsUsed: m.buttonsUsed,
  createdAt: m.createdAt,
})

async function jsonBody(ctx: WebContext): Promise<Record<string, unknown>> {
  const parsed = await readJsonCapped(ctx.req)
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
      const b = await jsonBody(ctx)
      const text = typeof b.text === 'string' ? b.text.trim() : ''
      if (!text || text.length > MAX_TEXT) return sendError(ctx.res, 400, 'bad_text')
      if (running.has(id)) return sendError(ctx.res, 409, 'busy')
      // A click answers the latest reply's card once. A stale tab, a second
      // click, or a label that card does not offer is refused.
      const clicked = buttonClickLabel(text)
      if (clicked !== null && !claimButtonClick(id, clicked)) return sendError(ctx.res, 409, 'buttons_used')

      running.add(id)
      try {
        addMessage(id, 'user', text)
        if (!conv.title) updateConversation(ctx.chatId, id, { title: text.replace(/\s+/g, ' ').slice(0, 60) })
        const sse = openSse(ctx.res, { heartbeatMs: 15_000 })
        // Deliberately no cancel on close: the turn finishes and is stored.

        let sent = ''
        try {
          const result = await runWebTurn({
            chatId: ctx.chatId,
            conversationId: id,
            text,
            framing: framingFor(conv.projectId),
            sessionId: conv.sessionId ?? undefined,
            model: conv.model || undefined,
            effort: (conv.effort || undefined) as 'low' | 'medium' | 'high' | 'xhigh' | undefined,
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
            sse.writeEvent('paused', { text: result.paused })
          } else if (result.cancelled || result.text === null) {
            sse.writeEvent('done', { cancelled: true })
          } else {
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
            const mid = addMessage(id, 'assistant', content, files, labels)
            const stored = listMessages(id).find((m) => m.id === mid)!
            sse.writeEvent('done', { cancelled: false, message: msgJson(stored) })
          }
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
