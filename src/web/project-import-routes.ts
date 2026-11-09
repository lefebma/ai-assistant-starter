/** Web routes for importing projects from a Claude or ChatGPT export (card #280, Feature #282). Everything is scoped to ctx.chatId. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerWebRoutes } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { streamToFile, safeUnlink, tooLarge } from './file-routes.js'
import { IMPORT_TMP_DIR, MAX_CHATGPT_UPLOAD, sweepImportTmp, previewImport, runImport, cancelImport, previewChatGPTImport, runChatGPTImport, type ChatPick } from '../projects/import.js'
import type { ParseError } from '../projects/claude-export.js'

const MAX_IMPORT_BYTES = 100 * 1024 * 1024

const PARSE_STATUS: Record<ParseError, [number, string]> = {
  too_large: [413, 'too_large'],
  manifest: [400, 'manifest'],
  not_projects: [400, 'not_projects'],
  corrupt: [400, 'corrupt'],
}

registerWebRoutes([
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/import$/,
    auth: true,
    upload: true,
    async handler(ctx) {
      const { req, res } = ctx
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/octet-stream') {
        req.resume()
        return sendError(res, 415, 'unsupported_media_type')
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) return tooLarge(req, res)

      sweepImportTmp()
      mkdirSync(IMPORT_TMP_DIR, { recursive: true })
      const part = join(IMPORT_TMP_DIR, `upload-${randomBytes(8).toString('hex')}.zip`)
      const outcome = await streamToFile(req, part, MAX_IMPORT_BYTES)
      if (outcome === 'too_large') return tooLarge(req, res)
      if (outcome === 'error') return sendError(res, 400, 'upload_failed')
      try {
        // previewImport removes the file itself when it cannot read it.
        const r = await previewImport(ctx.chatId, part)
        if ('error' in r) {
          const [status, code] = PARSE_STATUS[r.error]
          return sendError(res, status, code)
        }
        sendJson(res, 200, r)
      } catch {
        safeUnlink(part)
        sendError(res, 400, 'upload_failed')
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/import\/([^/]+)$/,
    auth: true,
    async handler(ctx) {
      let uuids: unknown
      try {
        uuids = ((await readJsonCapped(ctx.req)) as Record<string, unknown> | null)?.uuids
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      if (!Array.isArray(uuids) || !uuids.every((u) => typeof u === 'string')) return sendError(ctx.res, 400, 'bad_request')
      const r = runImport(ctx.chatId, ctx.params[0]!, uuids as string[])
      if ('error' in r) return sendError(ctx.res, 410, r.error)
      sendJson(ctx.res, 200, r)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/import\/([^/]+)\/cancel$/,
    auth: true,
    handler(ctx) {
      ctx.req.resume()
      cancelImport(ctx.chatId, ctx.params[0]!)
      sendJson(ctx.res, 200, { ok: true })
    },
  },
])

const CHAT_STATUS: Record<'not_chatgpt' | 'no_projects' | 'too_large' | 'corrupt', [number, string]> = {
  not_chatgpt: [400, 'not_chatgpt'],
  no_projects: [400, 'no_projects'],
  too_large: [413, 'too_large'],
  corrupt: [400, 'corrupt'],
}

/** At most this many picks in one import request; the parser allows 1,000 projects. */
const MAX_PICKS = 1000

registerWebRoutes([
  {
    // The browser reads the export zip and sends only the conversations in ChatGPT projects.
    method: 'POST',
    pattern: /^\/api\/web\/projects\/chatgpt-import$/,
    auth: true,
    upload: true,
    async handler(ctx) {
      const { req, res } = ctx
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/octet-stream') {
        req.resume()
        return sendError(res, 415, 'unsupported_media_type')
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_CHATGPT_UPLOAD) return tooLarge(req, res)

      sweepImportTmp()
      mkdirSync(IMPORT_TMP_DIR, { recursive: true })
      const part = join(IMPORT_TMP_DIR, `chatgpt-${randomBytes(8).toString('hex')}.json`)
      const outcome = await streamToFile(req, part, MAX_CHATGPT_UPLOAD)
      if (outcome === 'too_large') return tooLarge(req, res)
      if (outcome === 'error') return sendError(res, 400, 'upload_failed')
      try {
        // previewChatGPTImport always removes the upload.
        const r = previewChatGPTImport(ctx.chatId, part)
        if ('error' in r) {
          const [status, code] = CHAT_STATUS[r.error]
          return sendError(res, status, code)
        }
        sendJson(res, 200, r)
      } catch {
        safeUnlink(part)
        sendError(res, 400, 'upload_failed')
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/chatgpt-import\/([^/]+)$/,
    auth: true,
    async handler(ctx) {
      let projects: unknown
      try {
        projects = ((await readJsonCapped(ctx.req)) as Record<string, unknown> | null)?.projects
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      const ok =
        Array.isArray(projects) &&
        projects.length <= MAX_PICKS &&
        projects.every(
          (p) =>
            typeof p === 'object' && p !== null &&
            typeof (p as ChatPick).id === 'string' &&
            typeof (p as ChatPick).name === 'string' &&
            ((p as ChatPick).instructions === undefined || typeof (p as ChatPick).instructions === 'string')
        )
      if (!ok) return sendError(ctx.res, 400, 'bad_request')
      const picks = (projects as ChatPick[]).map((p) => ({ id: p.id, name: p.name, instructions: p.instructions ?? '' }))
      const r = runChatGPTImport(ctx.chatId, ctx.params[0]!, picks)
      if ('error' in r) return sendError(ctx.res, 410, r.error)
      sendJson(ctx.res, 200, r)
    },
  },
])
