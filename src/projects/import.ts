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
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { parseClaudeExport, type ExportProject, type ParseError } from './claude-export.js'
import { MAX_PROJECT_FILES, addProjectFile } from './files.js'
import { MAX_INSTRUCTIONS, MAX_NAME, MAX_PROJECTS, cleanName, createProject, setInstructions } from './store.js'

export const IMPORT_TMP_DIR = join(STORE_DIR, 'import-tmp')

const MAX_AGE_MS = 60 * 60 * 1000
const FULL_INSTRUCTIONS = 'Full instructions.md'
const UNTITLED = 'Untitled project'

const OVERFLOW_WARNING = `Instructions are longer than ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters. The first part goes in and the full text is saved as the file ${FULL_INSTRUCTIONS}.`
const FULL_FAILED = `Instructions are longer than ${MAX_INSTRUCTIONS.toLocaleString('en-US')} characters. The first part went in, but the full text could not be saved as a file.`
const manyFiles = (n: number) => `This project has ${n} files. The first ${MAX_PROJECT_FILES} come across.`
const TWICE = 'This project appears twice in the file.'
const LIMIT = `You have reached the limit of ${MAX_PROJECTS} projects.`
const NOT_CREATED = 'This project could not be created.'

export interface PreviewRow {
  uuid: string
  name: string
  hasInstructions: boolean
  files: number
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

interface Pending {
  chatId: string
  zipPath: string
  projects: ExportProject[]
  at: number
}

const pending = new Map<string, Pending>()

/** Test seams: run just before a project row is inserted, and just after. */
let hooks: { beforeCreate?: (source: string) => void; afterCreate?: (projectId: string) => void } = {}
export function setImportHooksForTest(next: typeof hooks | null): void {
  hooks = next ?? {}
}

export const pendingImportsForTest = (): number => pending.size

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

const sourceOf = (uuid: string) => `claude:${uuid}`

function alreadyImported(chatId: string, uuid: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM projects WHERE chat_id = ? AND source = ?').get(chatId, sourceOf(uuid))
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
  const parsed = await parseClaudeExport(zipPath)
  if (!parsed.ok) {
    removeFile(zipPath)
    logger.info({ code: parsed.code }, 'Claude import refused')
    return { error: parsed.code }
  }
  // One review at a time per chat: a newer upload replaces the earlier one.
  for (const [id, p] of pending) {
    if (p.chatId !== chatId) continue
    pending.delete(id)
    if (p.zipPath !== zipPath) removeFile(p.zipPath)
  }
  const importId = randomUUID()
  pending.set(importId, { chatId, zipPath, projects: parsed.projects, at: Date.now() })
  const rows = firstOfEach(parsed.projects).map((p): PreviewRow => {
    const { instructions, full } = importInstructions(p.description, p.template)
    const text = full ?? instructions
    return {
      uuid: p.uuid,
      name: baseName(p.name),
      hasInstructions: text !== '',
      files: p.docs.length,
      starter: p.starter,
      status: alreadyImported(chatId, p.uuid) ? 'already' : 'new',
      warnings: [...(full ? [OVERFLOW_WARNING] : []), ...(p.docs.length > MAX_PROJECT_FILES ? [manyFiles(p.docs.length)] : [])],
      instructions: text,
    }
  })
  logger.info({ projects: rows.length, unreadable: parsed.unreadable }, 'Claude import previewed')
  return { importId, rows, unreadable: parsed.unreadable }
}

type Created = { id: string; name: string } | { error: 'skipped' | 'failed'; reason?: string }

/** Create under the export's name, then `<name> (Claude)`, `(Claude 2)` and on, cut so the suffix fits. */
function createNamed(chatId: string, base: string, source: string): Created {
  for (let i = 1; i <= 100; i++) {
    const suffix = i === 1 ? '' : i === 2 ? ' (Claude)' : ` (Claude ${i - 1})`
    const name = suffix ? `${base.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}` : base
    let r: ReturnType<typeof createProject>
    hooks.beforeCreate?.(source)
    try {
      r = createProject(chatId, name, Date.now(), source)
    } catch (err) {
      // The unique index on source: another tab got there first.
      if (alreadyImported(chatId, source.slice('claude:'.length))) return { error: 'skipped' }
      logger.warn({ code: (err as { code?: string }).code }, 'Claude import could not create a project')
      return { error: 'failed', reason: NOT_CREATED }
    }
    if ('project' in r) return { id: r.project.id, name: r.project.name }
    if (r.error === 'too_many') return { error: 'failed', reason: LIMIT }
    if (r.error !== 'taken' && r.error !== 'reserved') return { error: 'failed', reason: NOT_CREATED }
  }
  return { error: 'failed', reason: NOT_CREATED }
}

const docName = (doc: { filename: string }, i: number) => (doc.filename ? docFileName(doc.filename) : `Document ${i + 1}.txt`)

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
  const written = new Set<string>()
  const leftOut: string[] = []
  try {
    if (alreadyImported(chatId, p.uuid)) return { uuid: p.uuid, name: base, status: 'skipped', leftOut: [] }
    if (projectCount(chatId) >= MAX_PROJECTS) return { uuid: p.uuid, name: base, status: 'failed', reason: LIMIT, leftOut: [] }

    const r = createNamed(chatId, base, sourceOf(p.uuid))
    if ('error' in r) return { uuid: p.uuid, name: base, status: r.error, ...(r.reason ? { reason: r.reason } : {}), leftOut: [] }
    made = r
    const id = r.id
    hooks.afterCreate?.(id)

    const add = (name: string, text: string): boolean => {
      try {
        if (!('error' in addProjectFile(id, name, { text }))) {
          written.add(name)
          return true
        }
      } catch (err) {
        logger.warn({ code: (err as NodeJS.ErrnoException).code }, 'Claude import could not write a file')
      }
      leftOut.push(name)
      return false
    }

    if (instructions) setInstructions(chatId, id, instructions)
    // First, so the docs cannot crowd it out of the file limit.
    const fullSaved = full ? add(FULL_INSTRUCTIONS, full) : false
    p.docs.forEach((doc, i) => {
      const name = docName(doc, i)
      if (doc.content === '') leftOut.push(name)
      else add(name, doc.content)
    })
    const reason = full ? (fullSaved ? OVERFLOW_WARNING : FULL_FAILED) : undefined
    return { uuid: p.uuid, name: r.name, status: 'created', ...(reason ? { reason } : {}), projectId: id, leftOut }
  } catch (err) {
    logger.warn({ code: (err as { code?: string }).code }, 'Claude import stopped part way through a project')
    if (!made) return { uuid: p.uuid, name: base, status: 'failed', reason: NOT_CREATED, leftOut: [] }
    const missing = planned.filter((n) => !written.has(n) && !leftOut.includes(n))
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
  if (!job || job.chatId !== chatId || Date.now() - job.at > MAX_AGE_MS) return { error: 'import_expired' }
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
