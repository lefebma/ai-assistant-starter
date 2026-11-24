// How the files panel shows a file. Local files derive the kind from the name,
// Drive files from the mime type. Mirrors src/web/file-kind.ts for the rows both agree on.
const TEXT_EXT = new Set(['txt', 'json', 'csv', 'log', 'html', 'htm'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const TEXT_MIME = new Set(['text/plain', 'text/csv', 'text/html', 'application/json'])
const PDF_MIME = new Set([
  'application/pdf',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

export function kindFromName(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md') return 'markdown'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'other'
}

export function kindFromMime(mime) {
  if (IMAGE_MIME.has(mime)) return 'image'
  if (PDF_MIME.has(mime)) return 'pdf'
  if (mime === 'text/markdown') return 'markdown'
  if (TEXT_MIME.has(mime)) return 'text'
  return 'other'
}
