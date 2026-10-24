/** Web file routes: lazy tree, preview, and upload. Containment lives in files.ts. */
import { createReadStream, createWriteStream, linkSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { registerWebRoutes } from './http.js'
import { sendJson, sendError } from './respond.js'
import { getFileRoots, listDir, resolveVisible, sanitizeUploadName } from './files.js'

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.html', '.htm'])
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function dispositionName(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_')
}

registerWebRoutes([
  {
    method: 'GET',
    pattern: /^\/api\/web\/files$/,
    auth: true,
    handler(ctx) {
      const listing = listDir(ctx.url.searchParams.get('path') ?? '')
      if (!listing) return sendError(ctx.res, 404, 'not_found')
      sendJson(ctx.res, 200, listing)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/web\/files\/raw$/,
    auth: true,
    handler(ctx) {
      const found = resolveVisible(ctx.url.searchParams.get('path') ?? '')
      if (!found || found.isDir) return sendError(ctx.res, 404, 'not_found')
      let size: number
      try {
        size = statSync(found.abs).size
      } catch {
        return sendError(ctx.res, 404, 'not_found')
      }
      const ext = extname(found.abs).toLowerCase()
      const name = dispositionName(found.rel.split('/').pop() ?? 'file')
      const headers: Record<string, string | number> = { 'X-Content-Type-Options': 'nosniff', 'Content-Length': size }
      if (TEXT_EXT.has(ext) && size <= MAX_TEXT_PREVIEW_BYTES) {
        headers['Content-Type'] = 'text/plain; charset=utf-8'
        headers['Content-Disposition'] = `inline; filename="${name}"`
      } else if (ext in IMAGE_MIME) {
        headers['Content-Type'] = IMAGE_MIME[ext]
        headers['Content-Disposition'] = `inline; filename="${name}"`
        if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'"
      } else if (ext === '.pdf') {
        headers['Content-Type'] = 'application/pdf'
        headers['Content-Disposition'] = `inline; filename="${name}"`
        // The page frames the PDF, so allow our own origin to do that and nothing else.
        headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'self'"
        headers['X-Frame-Options'] = 'SAMEORIGIN'
      } else {
        headers['Content-Type'] = 'application/octet-stream'
        headers['Content-Disposition'] = `attachment; filename="${name}"`
      }
      ctx.res.writeHead(200, headers)
      const stream = createReadStream(found.abs)
      stream.on('error', () => ctx.res.destroy())
      stream.pipe(ctx.res)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/web\/files\/upload$/,
    auth: true,
    upload: true,
    async handler(ctx) {
      const { res, req } = ctx
      const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/octet-stream') return sendError(res, 415, 'unsupported_media_type')
      const name = sanitizeUploadName(ctx.url.searchParams.get('name') ?? '')
      if (!name) return sendError(res, 400, 'bad_name')
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge(req, res)

      const { root, uploadsDir } = getFileRoots()
      mkdirSync(uploadsDir, { recursive: true })
      const tmp = join(uploadsDir, `.upload-${randomBytes(8).toString('hex')}.part`)
      const outcome = await streamToFile(req, tmp)
      if (outcome === 'too_large') {
        safeUnlink(tmp)
        return tooLarge(req, res)
      }
      if (outcome === 'error') {
        safeUnlink(tmp)
        return sendError(res, 400, 'upload_failed')
      }

      // link() fails if the target exists, so a name is never overwritten.
      const dot = extname(name)
      const stem = dot ? name.slice(0, -dot.length) : name
      let final = ''
      for (let i = 0; i < 1000; i++) {
        const candidate = join(uploadsDir, i === 0 ? name : `${stem}-${i}${dot}`)
        try {
          linkSync(tmp, candidate)
          final = candidate
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            safeUnlink(tmp)
            return sendError(res, 500, 'internal_error')
          }
        }
      }
      safeUnlink(tmp)
      if (!final) return sendError(res, 409, 'name_taken')
      sendJson(res, 200, { path: relative(root, final).split(sep).join('/') })
    },
  },
])

function safeUnlink(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // already gone
  }
}

function tooLarge(req: IncomingMessage, res: import('node:http').ServerResponse): void {
  if (!res.headersSent) {
    res.setHeader('Connection', 'close')
    sendError(res, 413, 'too_large')
  }
  // Drain what is still coming without keeping it, then drop the socket.
  req.resume()
  const t = setTimeout(() => req.destroy(), 2000)
  t.unref?.()
  res.once('finish', () => setTimeout(() => req.destroy(), 500).unref?.())
}

/**
 * Stream the body to `path`. On any failure the temp file is deleted once the
 * write stream has closed: the stream opens asynchronously, so an abort right
 * after the headers would otherwise unlink before the file exists and leave
 * an empty `.part` behind once the open completes.
 */
export function streamToFile(req: IncomingMessage, path: string): Promise<'ok' | 'too_large' | 'error'> {
  return new Promise((resolveP) => {
    const out = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    let size = 0
    let settled = false
    const succeed = (): void => {
      if (settled) return
      settled = true
      resolveP('ok')
    }
    const fail = (r: 'too_large' | 'error'): void => {
      if (settled) return
      settled = true
      req.pause()
      const cleanup = (): void => {
        safeUnlink(path)
        resolveP(r)
      }
      if (out.closed) cleanup()
      else {
        out.once('close', cleanup)
        out.destroy()
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) return fail('too_large')
      if (!out.write(chunk)) {
        req.pause()
        out.once('drain', () => req.resume())
      }
    })
    req.on('end', () => {
      if (settled) return
      out.end(() => succeed())
    })
    req.on('aborted', () => fail('error'))
    req.on('error', () => fail('error'))
    // A socket that closes before the body ends never says 'end'.
    req.on('close', () => {
      if (!req.complete) fail('error')
    })
    out.on('error', () => fail('error'))
  })
}
