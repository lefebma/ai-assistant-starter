/**
 * Import from Claude (card #280). The owner uploads Claude's projects export,
 * reviews what is in it, and picks which ones become projects here.
 *
 * Nothing leaves the box and no model is involved. A parsed export is held in
 * memory between the review and the import, keyed by an id that only the chat
 * that uploaded it can use. Every imported project carries `claude:<uuid>` as
 * its source, unique per chat, so the same export can never make a project
 * twice. Logs carry counts only: names and content are the owner's.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { parseClaudeExport, type ExportProject, type ParseError } from './claude-export.js'
import { historyFiles, dayOf, parseChatGPTConversations, UNTITLED_CONVERSATION, type ChatParseError, type ChatProject } from './chatgpt-export.js'
import { MAX_PROJECT_FILES, addProjectFile } from './files.js'
import { sanitizeUploadName } from '../web/files.js'
import { MAX_INSTRUCTIONS, MAX_NAME, MAX_PROJECTS, cleanName, createProject, setInstructions } from './store.js'

export const IMPORT_TMP_DIR = join(STORE_DIR, 'import-tmp')

const MAX_AGE_MS = 60 * 60 * 1000
const SWEEP_EVERY_MS = 10 * 60 * 1000
/** The review shows this much of a project's instructions; the whole text still goes in. */
export const MAX_REVIEW_INSTRUCTIONS = 200_000
const REVIEW_CUT = '(Longer than shown. The full text will be saved as a file.)'
const FULL_INSTRUCTIONS = 'Full instructions.md'
const UNTITLED = 'Untitled project'

const OVERFLOW_WARNING = `Instructions are longer than ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters. The first part goes in and the full text is saved as the file ${FULL_INSTRUCTIONS}.`
const FULL_FAILED = `Instructions are longer than ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters. The first part went in, but the full text could not be saved as a file.`
const manyFiles = (n: number) => `This project has ${n} files. The first ${MAX_PROJECT_FILES} come across.`
const TWICE = 'This project appears twice in the file.'
const TWICE_PICKED = 'This project was picked twice.'
const LIMIT = `You have reached the limit of ${MAX_PROJECTS} projects.`
const NOT_CREATED = 'This project could not be created.'

export interface PreviewRow {
  uuid: string
  name: string
  hasInstructions: boolean
  files: number
  /** The names the docs will be saved under, so the owner's tick approves them too. */
  fileNames: string[]
  starter: boolean
  status: 'new' | 'already'
  warnings: string[]
  instructions: string
}

export interface ResultRow {
  uuid: string
  name: string
  status: 'created' | 'skipped' | 'failed'
  reason?: string
  projectId?: string
  leftOut: string[]
}

type Pending = { chatId: string; zipPath: string; at: number } & ({ kind: 'claude'; projects: ExportProject[] } | { kind: 'chatgpt'; chat: ChatProject[] })

const pending = new Map<string, Pending>()

/** Test seams: run just before a project row is inserted, just after, and after each doc (with the name it was saved under, or ''). */
let hooks: { beforeCreate?: (source: string) => void; afterCreate?: (projectId: string) => void; afterFile?: (savedName: string) => void } = {}
export function setImportHooksForTest(next: typeof hooks | null): void {
  hooks = next ?? {}
}

export const pendingImportsForTest = (): number => pending.size

/**
 * Pending reviews and temp uploads also go on a timer, so an export nobody
 * comes back to does not sit in memory until the next upload. Started by
 * the first preview; unref'd so it never keeps the process alive.
 */
let sweeper: NodeJS.Timeout | null = null
function startSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => sweepImportTmp(), SWEEP_EVERY_MS)
  sweeper.unref()
}
export function stopImportSweepForTest(): void {
  if (sweeper) clearInterval(sweeper)
  sweeper = null
}

function dropPending(id: string): void {
  const job = pending.get(id)
  if (!job) return
  pending.delete(id)
  removeFile(job.zipPath)
}

/** Parsed exports can be large; none is kept past an hour. */
function dropExpired(now: number = Date.now()): void {
  for (const [id, p] of pending) if (now - p.at > MAX_AGE_MS) dropPending(id)
}

/**
 * The description above the template, as one text. Over the cap, the part
 * that goes in is cut at the last line break before the limit (or at the
 * limit), and `full` is the whole text, to be kept as a file.
 */
export function importInstructions(description: string, template: string): { instructions: string; full: string | null } {
  const parts: string[] = []
  if (description.trim()) parts.push(`About this project: ${description.trim()}`)
  if (template.trim()) parts.push(template.trim())
  const text = parts.join('\n\n')
  if (text.length <= MAX_INSTRUCTIONS) return { instructions: text, full: null }
  const head = text.slice(0, MAX_INSTRUCTIONS)
  const at = head.lastIndexOf('\n')
  return { instructions: (at > 0 ? head.slice(0, at) : head).trimEnd(), full: text }
}

/** Docs arrive as text, so a `.pptx` of text must not pass for a PowerPoint file. */
export function docFileName(filename: string): string {
  return /\.(md|txt|csv)$/i.test(filename) ? filename : `${filename}.txt`
}

const docName = (doc: { filename: string }, i: number) => (doc.filename ? docFileName(doc.filename) : `Document ${i + 1}.txt`)

const sourceOf = (uuid: string) => `claude:${uuid}`

function alreadyImported(chatId: string, uuid: string): boolean {
  return sourceTaken(chatId, sourceOf(uuid))
}

function sourceTaken(chatId: string, source: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM projects WHERE chat_id = ? AND source = ?').get(chatId, source)
}

function projectCount(chatId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM projects WHERE chat_id = ?').get(chatId) as { n: number }).n
}

const baseName = (raw: string): string => cleanName(raw).slice(0, MAX_NAME).trim() || UNTITLED

/** The export's first project for each uuid; a repeat is reported, never offered. */
function firstOfEach(projects: ExportProject[]): ExportProject[] {
  const seen = new Set<string>()
  return projects.filter((p) => !seen.has(p.uuid) && !!seen.add(p.uuid))
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (err) {
    logger.warn({ code: (err as NodeJS.ErrnoException).code }, 'Could not remove an import temp file')
  }
}

/** Delete temp uploads over an hour old, and forget imports left that long. */
export function sweepImportTmp(now: number = Date.now()): void {
  dropExpired(now)
  let names: string[]
  try {
    names = readdirSync(IMPORT_TMP_DIR)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(IMPORT_TMP_DIR, name)
    try {
      const st = statSync(path)
      if (st.isFile() && now - st.mtimeMs > MAX_AGE_MS) removeFile(path)
    } catch {
      // vanished while sweeping
    }
  }
}

/**
 * Read an uploaded export and describe what importing it would do. Creates
 * nothing. A file that cannot be read is removed and the reason returned.
 */
export async function previewImport(chatId: string, zipPath: string): Promise<{ importId: string; rows: PreviewRow[]; unreadable: number } | { error: ParseError }> {
  sweepImportTmp()
  startSweeper()
  const parsed = await parseClaudeExport(zipPath)
  if (!parsed.ok) {
    removeFile(zipPath)
    logger.info({ code: parsed.code }, 'Claude import refused')
    return { error: parsed.code }
  }
  // One Claude review at a time per chat: a newer upload replaces the earlier one, never a ChatGPT one.
  for (const [id, p] of pending) {
    if (p.chatId !== chatId || p.kind !== 'claude') continue
    pending.delete(id)
    if (p.zipPath !== zipPath) removeFile(p.zipPath)
  }
  const importId = randomUUID()
  pending.set(importId, { chatId, zipPath, kind: 'claude', projects: parsed.projects, at: Date.now() })
  const rows = firstOfEach(parsed.projects).map((p): PreviewRow => {
    const { instructions, full } = importInstructions(p.description, p.template)
    const text = full ?? instructions
    return {
      uuid: p.uuid,
      name: baseName(p.name),
      hasInstructions: text !== '',
      files: p.docs.length,
      fileNames: p.docs.map(docName),
      starter: p.starter,
      status: alreadyImported(chatId, p.uuid) ? 'already' : 'new',
      warnings: [...(full ? [OVERFLOW_WARNING] : []), ...(p.docs.length > MAX_PROJECT_FILES ? [manyFiles(p.docs.length)] : [])],
      instructions: text.length > MAX_REVIEW_INSTRUCTIONS ? `${text.slice(0, MAX_REVIEW_INSTRUCTIONS)}\n${REVIEW_CUT}` : text,
    }
  })
  logger.info({ projects: rows.length, unreadable: parsed.unreadable }, 'Claude import previewed')
  return { importId, rows, unreadable: parsed.unreadable }
}

type Created = { id: string; name: string } | { error: 'skipped' | 'failed'; reason?: string }

/** Create under the export's name, then `<name> (Claude)`, `(Claude 2)` and on, cut so the suffix fits. */
function createNamed(chatId: string, base: string, source: string, label = 'Claude'): Created {
  for (let i = 1; i <= 100; i++) {
    const suffix = i === 1 ? '' : i === 2 ? ` (${label})` : ` (${label} ${i - 1})`
    const name = suffix ? `${base.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}` : base
    let r: ReturnType<typeof createProject>
    hooks.beforeCreate?.(source)
    try {
      r = createProject(chatId, name, Date.now(), source)
    } catch (err) {
      // The unique index on source: another tab got there first.
      if (sourceTaken(chatId, source)) return { error: 'skipped' }
      logger.warn({ code: (err as { code?: string }).code }, 'Project import could not create a project')
      return { error: 'failed', reason: NOT_CREATED }
    }
    if ('project' in r) return { id: r.project.id, name: r.project.name }
    if (r.error === 'too_many') return { error: 'failed', reason: LIMIT }
    if (r.error !== 'taken' && r.error !== 'reserved') return { error: 'failed', reason: NOT_CREATED }
  }
  return { error: 'failed', reason: NOT_CREATED }
}

/**
 * One project. Anything that throws once its row exists still answers
 * `created`, with every file that did not land in `leftOut`; before that,
 * `failed`. Either way the next project carries on.
 */
function importOne(chatId: string, p: ExportProject): ResultRow {
  const base = baseName(p.name)
  let made: { id: string; name: string } | null = null
  const { instructions, full } = importInstructions(p.description, p.template)
  const planned = [...(full ? [FULL_INSTRUCTIONS] : []), ...p.docs.map(docName)]
  // By place in `planned`: a file can be saved under another name than planned (a clash, a cleaned name).
  const written = new Map<number, string>()
  const settled = new Set<number>()
  const leftOut: string[] = []
  try {
    if (alreadyImported(chatId, p.uuid)) return { uuid: p.uuid, name: base, status: 'skipped', leftOut: [] }
    if (projectCount(chatId) >= MAX_PROJECTS) return { uuid: p.uuid, name: base, status: 'failed', reason: LIMIT, leftOut: [] }

    const r = createNamed(chatId, base, sourceOf(p.uuid))
    if ('error' in r) return { uuid: p.uuid, name: base, status: r.error, ...(r.reason ? { reason: r.reason } : {}), leftOut: [] }
    made = r
    const id = r.id
    hooks.afterCreate?.(id)

    const add = (at: number, text: string): boolean => {
      const name = planned[at]!
      settled.add(at)
      try {
        const saved = addProjectFile(id, name, { text })
        if (!('error' in saved)) {
          written.set(at, saved.name)
          return true
        }
      } catch (err) {
        logger.warn({ code: (err as NodeJS.ErrnoException).code }, 'Claude import could not write a file')
      }
      leftOut.push(name)
      return false
    }
    const first = full ? 1 : 0

    if (instructions) setInstructions(chatId, id, instructions)
    // First, so the docs cannot crowd it out of the file limit.
    const fullSaved = full ? add(0, full) : false
    p.docs.forEach((doc, i) => {
      const at = first + i
      if (doc.content === '') {
        settled.add(at)
        leftOut.push(planned[at]!)
      } else add(at, doc.content)
      hooks.afterFile?.(written.get(at) ?? '')
    })
    const reason = full ? (fullSaved ? OVERFLOW_WARNING : FULL_FAILED) : undefined
    return { uuid: p.uuid, name: r.name, status: 'created', ...(reason ? { reason } : {}), projectId: id, leftOut }
  } catch (err) {
    logger.warn({ code: (err as { code?: string }).code }, 'Claude import stopped part way through a project')
    if (!made) return { uuid: p.uuid, name: base, status: 'failed', reason: NOT_CREATED, leftOut: [] }
    const missing = planned.filter((_, at) => !settled.has(at))
    return { uuid: p.uuid, name: made.name, status: 'created', projectId: made.id, leftOut: [...leftOut, ...missing] }
  }
}

/**
 * Create the chosen projects one at a time, in export order, and answer for
 * each. The import is spent and its temp file removed when this returns.
 */
export function runImport(chatId: string, importId: string, uuids: string[]): { rows: ResultRow[] } | { error: 'import_expired' } {
  dropExpired()
  const job = pending.get(importId)
  if (!job || job.kind !== 'claude' || job.chatId !== chatId || Date.now() - job.at > MAX_AGE_MS) return { error: 'import_expired' }
  pending.delete(importId)
  const chosen = new Set(uuids)
  const done = new Set<string>()
  const rows: ResultRow[] = []
  try {
    for (const p of job.projects) {
      if (!chosen.has(p.uuid)) continue
      if (done.has(p.uuid)) {
        rows.push({ uuid: p.uuid, name: baseName(p.name), status: 'failed', reason: TWICE, leftOut: [] })
        continue
      }
      done.add(p.uuid)
      rows.push(importOne(chatId, p))
    }
  } finally {
    removeFile(job.zipPath)
  }
  const count = (s: ResultRow['status']) => rows.filter((r) => r.status === s).length
  logger.info({ created: count('created'), skipped: count('skipped'), failed: count('failed') }, 'Claude import finished')
  return { rows }
}

/** Drop an import the owner backed out of. Another chat's id does nothing. */
export function cancelImport(chatId: string, importId: string): void {
  dropExpired()
  if (pending.get(importId)?.chatId === chatId) dropPending(importId)
}

// ---------------------------------------------------------------------------
// Import from ChatGPT (Feature #282). The browser uploads only the
// conversations in ChatGPT projects, as one JSON array. The export holds no
// project names or instructions, so the owner gives them in the review.

/** The largest upload the ChatGPT import reads. */
export const MAX_CHATGPT_UPLOAD = 100 * 1024 * 1024
/** Titles shown for one project in the review. */
const MAX_REVIEW_TITLES = 200

export interface ChatPreviewRow {
  id: string
  /** A starting name; the owner can change it. */
  name: string
  conversations: number
  from: string
  to: string
  titles: string[]
  /** The names the history will be saved under. */
  fileNames: string[]
  status: 'new' | 'already'
}

export interface ChatPick {
  id: string
  name: string
  instructions: string
}

const chatSourceOf = (id: string) => `chatgpt:${id}`

/**
 * Read an uploaded array of ChatGPT conversations and describe the projects
 * in it. Creates nothing. The upload is removed once read, whatever happens.
 */
export function previewChatGPTImport(chatId: string, path: string): { importId: string; rows: ChatPreviewRow[]; unreadable: number } | { error: ChatParseError | 'corrupt' } {
  sweepImportTmp()
  startSweeper()
  let data: unknown
  try {
    if (statSync(path).size > MAX_CHATGPT_UPLOAD) return { error: 'too_large' }
    data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  } catch {
    return { error: 'corrupt' }
  } finally {
    removeFile(path)
  }
  const parsed = parseChatGPTConversations(data)
  if (!parsed.ok) {
    logger.info({ code: parsed.code }, 'ChatGPT import refused')
    return { error: parsed.code }
  }
  // A newer ChatGPT upload replaces an earlier ChatGPT review, never a Claude one in progress.
  for (const [id, p] of pending) {
    if (p.chatId !== chatId || p.kind !== 'chatgpt') continue
    pending.delete(id)
    removeFile(p.zipPath)
  }
  const importId = randomUUID()
  pending.set(importId, { chatId, zipPath: path, kind: 'chatgpt', chat: parsed.projects, at: Date.now() })
  const rows = parsed.projects.map((p, i): ChatPreviewRow => {
    const days = p.conversations.map((c) => dayOf(c.created)).filter(Boolean).sort()
    return {
      id: p.id,
      name: `ChatGPT project ${i + 1}`,
      conversations: p.conversations.length,
      from: days[0] ?? '',
      to: days[days.length - 1] ?? '',
      titles: p.conversations.slice(0, MAX_REVIEW_TITLES).map((c) => c.title || UNTITLED_CONVERSATION),
      fileNames: historyFiles(p.conversations).map((f) => sanitizeUploadName(f.name) || f.name),
      status: sourceTaken(chatId, chatSourceOf(p.id)) ? 'already' : 'new',
    }
  })
  logger.info({ projects: rows.length, unreadable: parsed.unreadable }, 'ChatGPT import previewed')
  return { importId, rows, unreadable: parsed.unreadable }
}

function importChatProject(chatId: string, p: ChatProject, pick: ChatPick): ResultRow {
  const base = cleanName(pick.name).slice(0, MAX_NAME).trim() || UNTITLED
  const source = chatSourceOf(p.id)
  let made: { id: string; name: string } | null = null
  const { instructions, full } = importInstructions('', pick.instructions)
  const files = [...(full ? [{ name: FULL_INSTRUCTIONS, text: full }] : []), ...historyFiles(p.conversations)]
  const settled = new Set<number>()
  const leftOut: string[] = []
  try {
    if (sourceTaken(chatId, source)) return { uuid: p.id, name: base, status: 'skipped', leftOut: [] }
    if (projectCount(chatId) >= MAX_PROJECTS) return { uuid: p.id, name: base, status: 'failed', reason: LIMIT, leftOut: [] }
    const r = createNamed(chatId, base, source, 'ChatGPT')
    if ('error' in r) return { uuid: p.id, name: base, status: r.error, ...(r.reason ? { reason: r.reason } : {}), leftOut: [] }
    made = r
    hooks.afterCreate?.(r.id)
    if (instructions) setInstructions(chatId, r.id, instructions)
    let fullSaved = false
    files.forEach((f, at) => {
      settled.add(at)
      let saved = ''
      try {
        const res = addProjectFile(r.id, f.name, { text: f.text })
        if (!('error' in res)) saved = res.name
      } catch (err) {
        logger.warn({ code: (err as NodeJS.ErrnoException).code }, 'ChatGPT import could not write a file')
      }
      if (saved) {
        if (full && at === 0) fullSaved = true
      } else leftOut.push(f.name)
      hooks.afterFile?.(saved)
    })
    const reason = full ? (fullSaved ? OVERFLOW_WARNING : FULL_FAILED) : undefined
    return { uuid: p.id, name: r.name, status: 'created', ...(reason ? { reason } : {}), projectId: r.id, leftOut }
  } catch (err) {
    logger.warn({ code: (err as { code?: string }).code }, 'ChatGPT import stopped part way through a project')
    if (!made) return { uuid: p.id, name: base, status: 'failed', reason: NOT_CREATED, leftOut: [] }
    const missing = files.filter((_, at) => !settled.has(at)).map((f) => f.name)
    return { uuid: p.id, name: made.name, status: 'created', projectId: made.id, leftOut: [...leftOut, ...missing] }
  }
}

/**
 * Create the chosen ChatGPT projects, in the order of the review, and answer
 * for each. The import is spent when this returns.
 */
export function runChatGPTImport(chatId: string, importId: string, picks: ChatPick[]): { rows: ResultRow[] } | { error: 'import_expired' } {
  dropExpired()
  const job = pending.get(importId)
  if (!job || job.kind !== 'chatgpt' || job.chatId !== chatId || Date.now() - job.at > MAX_AGE_MS) return { error: 'import_expired' }
  pending.delete(importId)
  // A project picked twice in one request is refused rather than guessed at.
  const chosen = new Map<string, ChatPick>()
  const twice = new Set<string>()
  for (const p of picks) {
    if (chosen.has(p.id)) twice.add(p.id)
    else chosen.set(p.id, p)
  }
  const rows: ResultRow[] = []
  for (const p of job.chat) {
    const pick = chosen.get(p.id)
    if (!pick) continue
    if (twice.has(p.id)) {
      rows.push({ uuid: p.id, name: cleanName(pick.name).slice(0, MAX_NAME).trim() || UNTITLED, status: 'failed', reason: TWICE_PICKED, leftOut: [] })
      continue
    }
    rows.push(importChatProject(chatId, p, pick))
  }
  const count = (s: ResultRow['status']) => rows.filter((r) => r.status === s).length
  logger.info({ created: count('created'), skipped: count('skipped'), failed: count('failed') }, 'ChatGPT import finished')
  return { rows }
}
