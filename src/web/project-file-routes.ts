/** Web routes for project files (card #280). Names are only ever ones listProjectFiles returns. */
import { createReadStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerWebRoutes, type WebContext } from './http.js'
import { sendJson, sendError, readJsonCapped, BodyError } from './respond.js'
import { MAX_UPLOAD_BYTES, sanitizeUploadName } from './files.js'
import { streamToFile, safeUnlink, tooLarge } from './file-routes.js'
import { getProject } from '../projects/store.js'
import { addProjectFile, listProjectFiles, projectFilesDir, removeProjectFile, type AddFileError } from '../projects/files.js'

const ADD_STATUS: Record<AddFileError, [number, string]> = {
  bad_name: [400, 'bad_name'],
  too_big: [413, 'too_large'],
  too_many: [409, 'too_many'],
  project_full: [409, 'project_full'],
}

/** The project id when this chat owns it; otherwise answers 404 and returns null. */
function owned(ctx: WebContext): string | null {
  const id = ctx.params[0]!
  if (getProject(ctx.chatId, id)) return id
  sendError(ctx.res, 404, 'not_found')
  // A body may still be on its way; drop it.
  ctx.req.resume()
  return null
}

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/projects\/([^/]+)\/files$/,
    auth: true,
    handler(ctx) {
      const id = owned(ctx)
      if (id) sendJson(ctx.res, 200, { files: listProjectFiles(id) })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/([^/]+)\/files$/,
    auth: true,
    upload: true,
    async handler(ctx) {
      const { req, res } = ctx
      const id = owned(ctx)
      if (!id) return
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/octet-stream') {
        req.resume()
        return sendError(res, 415, 'unsupported_media_type')
      }
      const name = sanitizeUploadName(ctx.url.searchParams.get('name') ?? '')
      if (!name) {
        req.resume()
        return sendError(res, 400, 'bad_name')
      }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge(req, res)

      const dir = projectFilesDir(id)
      mkdirSync(dir, { recursive: true })
      const part = join(dir, `.upload-${randomBytes(8).toString('hex')}.part`)
      const outcome = await streamToFile(req, part, MAX_UPLOAD_BYTES)
      if (outcome === 'too_large') return tooLarge(req, res)
      if (outcome === 'error') return sendError(res, 400, 'upload_failed')
      try {
        const r = addProjectFile(id, name, { path: part })
        if ('error' in r) {
          const [status, code] = ADD_STATUS[r.error]
          return sendError(res, status, code)
        }
        const file = listProjectFiles(id).find((f) => f.name === r.name)
        sendJson(res, 200, { file: file ?? { name: r.name, size: 0 } })
      } catch {
        sendError(res, 400, 'upload_failed')
      } finally {
        safeUnlink(part)
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/projects\/([^/]+)\/files\/delete$/,
    auth: true,
    async handler(ctx) {
      const id = owned(ctx)
      if (!id) return
      let name = ''
      try {
        const b = (await readJsonCapped(ctx.req)) as Record<string, unknown>
        if (typeof b?.name === 'string') name = b.name
      } catch (err) {
        if (err instanceof BodyError) return sendError(ctx.res, err.status, err.code)
        throw err
      }
      if (!removeProjectFile(id, name)) return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, { ok: true })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/projects\/([^/]+)\/files\/([^/]+)$/,
    auth: true,
    handler(ctx) {
      const id = owned(ctx)
      if (!id) return
      const name = ctx.params[1]!
      const file = listProjectFiles(id).find((f) => f.name === name)
      if (!file) return sendError(ctx.res, 404, 'not_found')
      const safe = name.replace(/[^\w.\- ]/g, '_')
      ctx.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${safe}"`,
        'X-Content-Type-Options': 'nosniff',
      })
      const stream = createReadStream(join(projectFilesDir(id), name))
      stream.on('error', () => ctx.res.destroy())
      stream.pipe(ctx.res)
    },
  },
])
