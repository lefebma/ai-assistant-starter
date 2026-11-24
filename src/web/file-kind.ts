import { extname } from 'node:path'
import { GOOGLE_EXPORT_PDF } from './drive.js'

/** How the files panel shows a file. Local files derive it from the name, Drive files from the mime type. */
export type FileKind = 'image' | 'pdf' | 'text' | 'markdown' | 'other'

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

const TEXT_EXT = new Set(['.txt', '.json', '.csv', '.html', '.htm'])
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}
const IMAGE_MIMES = new Set(Object.values(IMAGE_MIME))
const TEXT_MIMES = new Set(['text/plain', 'text/csv', 'text/html', 'application/json'])
const OTHER = { kind: 'other' as const, mime: 'application/octet-stream' }

export function dispositionName(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_')
}

export function kindFromName(name: string): { kind: FileKind; mime: string } {
  const ext = extname(name).toLowerCase()
  if (ext === '.md') return { kind: 'markdown', mime: 'text/markdown' }
  if (TEXT_EXT.has(ext)) return { kind: 'text', mime: 'text/plain' }
  if (ext in IMAGE_MIME) return { kind: 'image', mime: IMAGE_MIME[ext] }
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' }
  return { ...OTHER }
}

export function kindFromMime(mime: string): { kind: FileKind; mime: string } {
  if (IMAGE_MIMES.has(mime)) return { kind: 'image', mime }
  if (mime === 'application/pdf' || GOOGLE_EXPORT_PDF.has(mime)) return { kind: 'pdf', mime: 'application/pdf' }
  if (mime === 'text/markdown') return { kind: 'markdown', mime }
  if (TEXT_MIMES.has(mime)) return { kind: 'text', mime }
  return { ...OTHER }
}

export function rawHeaders(kind: FileKind, mime: string, name: string, size: number): Record<string, string | number> {
  const safe = dispositionName(name)
  const headers: Record<string, string | number> = { 'X-Content-Type-Options': 'nosniff', 'Content-Length': size }
  if ((kind === 'text' || kind === 'markdown') && size <= MAX_TEXT_PREVIEW_BYTES) {
    headers['Content-Type'] = 'text/plain; charset=utf-8'
    headers['Content-Disposition'] = `inline; filename="${safe}"`
  } else if (kind === 'image') {
    headers['Content-Type'] = mime
    headers['Content-Disposition'] = `inline; filename="${safe}"`
    if (mime === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'"
  } else if (kind === 'pdf') {
    headers['Content-Type'] = 'application/pdf'
    headers['Content-Disposition'] = `inline; filename="${safe}"`
    // The page frames the PDF, so allow our own origin to do that and nothing else.
    headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'self'"
    headers['X-Frame-Options'] = 'SAMEORIGIN'
  } else {
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Disposition'] = `attachment; filename="${safe}"`
  }
  return headers
}
