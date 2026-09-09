import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../env.js'
import { extractOwnerName } from '../skills/sync.js'
import type { WorkspaceEntry } from './types.js'

const FILE = 'workspaces.json'

function file(storeDir: string): string {
  return resolve(storeDir, FILE)
}

export function loadRegistry(storeDir: string = STORE_DIR): WorkspaceEntry[] {
  const p = file(storeDir)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (Array.isArray(parsed)) return parsed as WorkspaceEntry[]
    logger.warn({ file: p }, 'workspace registry is not an array, ignoring it')
    return []
  } catch (err) {
    // Silently returning [] here means every workspace stops syncing and
    // /workspace status says "No workspaces joined." Say so instead.
    logger.warn({ file: p, err }, 'workspace registry could not be parsed, treating it as empty')
    return []
  }
}

/** Temp file then rename, so a crash mid-write cannot leave a half file that
 * parses as "no workspaces joined". */
export function saveRegistry(entries: WorkspaceEntry[], storeDir: string = STORE_DIR): void {
  mkdirSync(storeDir, { recursive: true })
  const target = file(storeDir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n')
  renameSync(tmp, target)
}

export function getWorkspace(name: string, storeDir: string = STORE_DIR): WorkspaceEntry | undefined {
  return loadRegistry(storeDir).find((w) => w.name === name)
}

export function upsertWorkspace(entry: WorkspaceEntry, storeDir: string = STORE_DIR): void {
  const entries = loadRegistry(storeDir).filter((w) => w.name !== entry.name)
  entries.push(entry)
  saveRegistry(entries, storeDir)
}

export function removeWorkspace(name: string, storeDir: string = STORE_DIR): boolean {
  const entries = loadRegistry(storeDir)
  const kept = entries.filter((w) => w.name !== name)
  if (kept.length === entries.length) return false
  saveRegistry(kept, storeDir)
  return true
}

export function workspaceDir(entry: WorkspaceEntry, root: string = PROJECT_ROOT): string {
  return entry.path || resolve(root, 'workspaces', entry.name)
}

/**
 * Who this install is, for commit identity and the provider banner.
 * ASSISTANT_NAME / OWNER_NAME in the environment win; otherwise the
 * assistant name comes from PERSONALITY.md ("Your name is X") and the owner
 * from CLAUDE.md via the same helper the skill installer uses.
 */
export function identity(root: string = PROJECT_ROOT): { owner: string; assistant: string; email: string } {
  const owner = process.env.OWNER_NAME?.trim() || extractOwnerName()
  let assistant = process.env.ASSISTANT_NAME?.trim() || ''
  if (!assistant) {
    try {
      const p = readFileSync(resolve(root, 'PERSONALITY.md'), 'utf-8')
      const m = p.match(/Your name is ([A-Za-z][A-Za-z0-9 _-]*)/)
      if (m && m[1]) assistant = m[1].trim()
    } catch {
      // no PERSONALITY.md
    }
  }
  const name = assistant || 'Assistant'
  // First token only: a two-word assistant name would otherwise become a git
  // user.email with a space in it.
  const local = name.trim().split(/\s+/)[0].toLowerCase()
  return { owner, assistant: name, email: `${local}@havn.noreply` }
}
