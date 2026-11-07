/**
 * Project files (card #280): reference files the owner keeps in a project,
 * stored under the uploads folder at projects/<id>. The agent is told where
 * they are and may read them; nothing in them is an instruction.
 */
import { linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAX_UPLOAD_BYTES, getFileRoots, sanitizeUploadName } from '../web/files.js'

export const MAX_PROJECT_FILES = 50
export const MAX_PROJECT_BYTES = 250 * 1024 * 1024

let limits = { files: MAX_PROJECT_FILES, bytes: MAX_PROJECT_BYTES, fileBytes: MAX_UPLOAD_BYTES }

/** Test hook: lower the limits. Omitted or null keys reset to the real value. */
export function setProjectFileLimitsForTest(next: { files?: number | null; bytes?: number | null; fileBytes?: number | null } = {}): void {
  limits = {
    files: next.files ?? MAX_PROJECT_FILES,
    bytes: next.bytes ?? MAX_PROJECT_BYTES,
    fileBytes: next.fileBytes ?? MAX_UPLOAD_BYTES,
  }
}

export type AddFileError = 'bad_name' | 'too_big' | 'too_many' | 'project_full'

export function projectFilesDir(projectId: string): string {
  return join(getFileRoots().uploadsDir, 'projects', projectId)
}

export function listProjectFiles(projectId: string): { name: string; size: number }[] {
  const dir = projectFilesDir(projectId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: { name: string; size: number }[] = []
  for (const name of names) {
    if (name.startsWith('.') || name.endsWith('.part')) continue
    try {
      const st = statSync(join(dir, name))
      if (st.isFile()) out.push({ name, size: st.size })
    } catch {
      // vanished while listing
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function candidates(name: string): string[] {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return [name, ...Array.from({ length: 200 }, (_, i) => `${stem}-${i + 1}${ext}`)]
}

export function addProjectFile(projectId: string, rawName: string, source: { path: string } | { text: string }): { name: string } | { error: AddFileError } {
  const clean = sanitizeUploadName(rawName)
  if (!clean) return { error: 'bad_name' }
  const size = 'text' in source ? Buffer.byteLength(source.text) : statSync(source.path).size
  if (size > limits.fileBytes) return { error: 'too_big' }
  const existing = listProjectFiles(projectId)
  if (existing.length >= limits.files) return { error: 'too_many' }
  if (existing.reduce((n, f) => n + f.size, 0) + size > limits.bytes) return { error: 'project_full' }
  const dir = projectFilesDir(projectId)
  mkdirSync(dir, { recursive: true })
  for (const name of candidates(clean)) {
    const target = join(dir, name)
    try {
      if ('text' in source) writeFileSync(target, source.text, { flag: 'wx' })
      else linkSync(source.path, target)
      return { name }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  return { error: 'bad_name' }
}

/** Only a name that listProjectFiles returns. */
export function removeProjectFile(projectId: string, name: string): boolean {
  if (!listProjectFiles(projectId).some((f) => f.name === name)) return false
  rmSync(join(projectFilesDir(projectId), name), { force: true })
  return true
}

export function removeProjectFiles(projectId: string): void {
  if (!/^[\w-]+$/.test(projectId)) return
  try {
    rmSync(projectFilesDir(projectId), { recursive: true, force: true })
  } catch (err) {
    logger.warn({ err }, 'Could not remove project files')
  }
}
