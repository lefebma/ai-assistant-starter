/**
 * What the owner attaches to a web chat message (card #249): files uploaded
 * from the chat box (pasted, dropped or picked with the paperclip) and long
 * pasted text.
 *
 * An upload lands at the top of the uploads folder, where files older than a
 * day are cleared at startup. Sending moves it into the conversation's own
 * folder, `uploads/chat/<conversation>/`, so the picture in the chat history
 * still opens next month; deleting the conversation deletes the folder.
 *
 * Checking and moving are separate steps, so a message refused before the
 * turn starts (busy, a bad file) leaves every upload where it was.
 */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, linkSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getFileRoots, resolveVisible } from './files.js'
import { MAX_UPLOAD_BYTES } from './file-routes.js'
import type { StoredFile } from './conversations.js'

export const MAX_ATTACHMENTS = 10
export const MAX_PASTES = 5
export const MAX_PASTE_CHARS = 200_000

const PHOTO_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export type Attached = StoredFile & { /** Pasted text, inlined into the turn. */ text?: string }
export type AttachPlan = { uploads: Array<{ abs: string; name: string }>; pastes: string[] }
export type AttachError = 'bad_attachments' | 'attachment_missing' | 'too_many_attachments' | 'paste_too_long'

function within(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
}

/**
 * Check what the page sent. `attachments` are the paths the upload route
 * returned; each must still be a visible file at the top of the uploads
 * folder. Nothing is moved here.
 */
export function planAttachments(attachments: unknown, pastes: unknown): { ok: true; plan: AttachPlan } | { ok: false; code: AttachError } {
  const list = attachments ?? []
  const texts = pastes ?? []
  if (!Array.isArray(list) || !Array.isArray(texts)) return { ok: false, code: 'bad_attachments' }
  if (list.some((p) => typeof p !== 'string') || texts.some((t) => typeof t !== 'string')) return { ok: false, code: 'bad_attachments' }
  if (list.length > MAX_ATTACHMENTS || texts.length > MAX_PASTES) return { ok: false, code: 'too_many_attachments' }
  if ((texts as string[]).some((t) => t.length > MAX_PASTE_CHARS)) return { ok: false, code: 'paste_too_long' }

  const { root, uploadsDir } = getFileRoots()
  let realRoot: string
  let realUploads: string
  try {
    realRoot = realpathSync(root)
    realUploads = realpathSync(uploadsDir)
  } catch {
    return list.length ? { ok: false, code: 'attachment_missing' } : { ok: true, plan: { uploads: [], pastes: (texts as string[]).filter((t) => t.trim()) } }
  }
  const uploads: AttachPlan['uploads'] = []
  const seen = new Set<string>()
  for (const p of list as string[]) {
    if (!p || p.includes('\0')) return { ok: false, code: 'bad_attachments' }
    const abs = resolve(realRoot, p)
    if (!existsSync(abs)) return { ok: false, code: 'attachment_missing' }
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      return { ok: false, code: 'attachment_missing' }
    }
    // Only what the upload route wrote: a file directly in the uploads folder.
    if (dirname(real) !== realUploads || basename(real).startsWith('.')) return { ok: false, code: 'bad_attachments' }
    const rel = within(realRoot, real)
    const v = rel ? resolveVisible(rel.split(sep).join('/')) : null
    if (!v || v.isDir) return { ok: false, code: 'bad_attachments' }
    const st = statSync(real)
    if (!st.isFile() || st.size === 0 || st.size > MAX_UPLOAD_BYTES) return { ok: false, code: 'bad_attachments' }
    if (seen.has(real)) continue
    seen.add(real)
    uploads.push({ abs: real, name: basename(real) })
  }
  return { ok: true, plan: { uploads, pastes: (texts as string[]).filter((t) => t.trim()) } }
}

export function conversationDir(conversationId: string): string {
  return join(getFileRoots().uploadsDir, 'chat', conversationId)
}

/** A name in `dir` that is not taken yet: `name`, then `stem-1.ext`, ... */
function freeName(dir: string, name: string): string {
  const dot = extname(name)
  const stem = dot ? name.slice(0, -dot.length) : name
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${dot}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('no free file name')
}

/** Move the uploads into the conversation's folder and write the pastes there. */
export function commitAttachments(conversationId: string, plan: AttachPlan): Attached[] {
  if (!plan.uploads.length && !plan.pastes.length) return []
  const dir = conversationDir(conversationId)
  mkdirSync(dir, { recursive: true })
  const out: Attached[] = []
  for (const u of plan.uploads) {
    const dest = freeName(dir, u.name)
    renameSync(u.abs, dest)
    out.push({ path: dest, name: basename(dest), kind: PHOTO_EXT.has(extname(dest).toLowerCase()) ? 'photo' : 'document' })
  }
  plan.pastes.forEach((text) => {
    const dest = freeName(dir, 'pasted-text.txt')
    // link() refuses an existing name, so two sends at once cannot share a file.
    const tmp = `${dest}.${process.pid}.part`
    writeFileSync(tmp, text)
    try {
      linkSync(tmp, dest)
    } finally {
      unlinkSync(tmp)
    }
    out.push({ path: dest, name: basename(dest), kind: 'document', pasted: true, text })
  })
  return out
}

/** Delete a conversation's attachments with it. */
export function removeConversationFiles(conversationId: string): void {
  if (!/^[\w-]+$/.test(conversationId)) return
  rmSync(conversationDir(conversationId), { recursive: true, force: true })
}

const lineCount = (t: string) => t.split('\n').length

/**
 * The turn the agent gets: the owner's text plus one line per file, in the
 * same `[Photo attached: ...]` form a Telegram photo uses, so both runtimes
 * open it (Claude with Read, ai-sdk as an image part). Pasted text is inlined.
 */
export function attachmentTurnText(text: string, files: Attached[]): string {
  if (!files.length) return text
  const parts: string[] = []
  for (const f of files) {
    if (f.kind === 'photo') parts.push(`[Photo attached: ${f.path}]`)
    else if (f.pasted) parts.push(`[Pasted text, ${lineCount(f.text ?? '')} lines, saved at ${f.path}]\n<pasted-text>\n${f.text ?? ''}\n</pasted-text>`)
    else parts.push(`[Document attached: ${f.name} at ${f.path}]`)
  }
  const photos = files.filter((f) => f.kind === 'photo').length
  const docs = files.filter((f) => f.kind === 'document' && !f.pasted).length
  const ask = text || (photos && !docs ? (photos === 1 ? 'Please analyze this image.' : 'Please analyze these images.') : docs ? 'Please read and analyze what I attached.' : 'Please read what I pasted.')
  return `${parts.join('\n')}\n${ask}`
}

/** A title for a chat whose first message was only attachments. */
export function attachmentTitle(files: Attached[]): string {
  const f = files[0]
  if (!f) return ''
  if (f.pasted) return (f.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Pasted text'
  return f.kind === 'photo' ? 'Image' : f.name.slice(0, 60)
}

/** Stored without the inlined text: the file on disk holds it. */
export const toStored = (f: Attached): StoredFile => ({ path: f.path, name: f.name, kind: f.kind, ...(f.pasted ? { pasted: true } : {}) })
