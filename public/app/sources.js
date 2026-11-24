// Which files the files panel shows: Havn files on the box, or a Google Drive
// account (read only). Pure helpers over the /api/web/sources answer, no DOM.

export const STORAGE_KEY = 'havn.files.source'

const LOCAL = { id: 'local', label: 'Havn files' }
const CONNECT_ID = 'drive:'
// Google's own formats come back as a PDF, so they download as one.
const GOOGLE_EXPORTS = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

const GOOGLE_NATIVE = 'application/vnd.google-apps.'
const FOLDER = 'application/vnd.google-apps.folder'
const FETCHED = new Set(['image', 'pdf', 'text', 'markdown'])

/** The largest Drive file the panel previews or downloads (the server's cap too). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024

const ERRORS = {
  unavailable: 'Google Drive is not available right now. Try again in a minute.',
  too_large: 'This file is too large to preview here. Open it in Google Drive.',
  not_found: 'This file is no longer in Google Drive.',
  reconnect: 'Google Drive needs to be connected again.',
  not_connected: 'Google Drive needs to be connected again.',
}

function drives(resp) {
  const list = resp && Array.isArray(resp.sources) ? resp.sources : []
  return list.filter((src) => src && typeof src.id === 'string' && src.id.startsWith('drive:') && src.id.length > CONNECT_ID.length)
}

/** The picker's entries, Havn files first. */
export function pickerOptions(resp) {
  const found = drives(resp)
  const opts = [{ ...LOCAL }]
  for (const d of found) opts.push({ id: d.id, label: found.length > 1 ? 'Google Drive (' + d.account + ')' : 'Google Drive' })
  if (!found.length && resp && resp.canConnectDrive) opts.push({ id: CONNECT_ID, label: 'Google Drive' })
  return opts
}

/** The picker shows only when there is something besides Havn files. */
export function showPicker(resp) {
  return pickerOptions(resp).length > 1
}

/** The remembered source while it is still offered, else Havn files. */
export function resolveSource(saved, resp) {
  if (typeof saved !== 'string') return 'local'
  return pickerOptions(resp).some((o) => o.id === saved) ? saved : 'local'
}

/** What the panel shows for a source: its tree, or the Connect view. */
export function viewFor(id, resp) {
  if (id === 'local') return 'tree'
  const src = drives(resp).find((d) => d.id === id)
  if (!src) return 'connect'
  return src.state === 'reconnect' ? 'reconnect' : 'tree'
}

/** The account of a Drive source id ('' for the unconnected entry). */
export function accountOf(id) {
  return String(id).startsWith('drive:') ? String(id).slice(CONNECT_ID.length) : ''
}

/** Whether a listing has another page to load. */
export function needsMore(resp) {
  return Boolean(resp && resp.nextPage)
}

export function driveListUrl(account, folder, page) {
  let url = '/api/web/sources/drive/list?account=' + encodeURIComponent(account)
  if (folder) url += '&folder=' + encodeURIComponent(folder)
  if (page) url += '&page=' + encodeURIComponent(page)
  return url
}

export function driveRawUrl(account, id) {
  return '/api/web/sources/drive/raw?account=' + encodeURIComponent(account) + '&id=' + encodeURIComponent(id)
}

export function driveOpenUrl(id) {
  return 'https://drive.google.com/open?id=' + encodeURIComponent(id)
}

/** The name a Drive file saves under: Google Docs, Sheets and Slides save as PDF. */
export function downloadName(entry) {
  const name = String((entry && entry.name) || 'file')
  return entry && GOOGLE_EXPORTS.has(entry.mimeType) && !/\.pdf$/i.test(name) ? name + '.pdf' : name
}

/** Plain words for a Drive error code. */
export function errorText(code) {
  return Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : ERRORS.unavailable
}

/**
 * How the panel shows a Drive file, from its list entry ({ kind, mimeType, size? }):
 * too_large (over the cap), no_file (a Google type with nothing to hand over,
 * such as a Form), fetch (the page loads it first, so a failure can be explained),
 * or other (no preview, Download offered).
 */
export function drivePreviewPlan(entry) {
  const mime = String((entry && entry.mimeType) || '')
  const size = entry && entry.size !== undefined && entry.size !== null && entry.size !== '' ? Number(entry.size) : NaN
  if (Number.isFinite(size) && size > MAX_PREVIEW_BYTES) return { mode: 'too_large' }
  if (mime.startsWith(GOOGLE_NATIVE) && mime !== FOLDER && !GOOGLE_EXPORTS.has(mime)) return { mode: 'no_file' }
  if (entry && FETCHED.has(entry.kind)) return { mode: 'fetch' }
  return { mode: 'other' }
}

/** The sign-in link to open, only when it is https; null for anything else. */
export function safeSignInUrl(url) {
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null
}
