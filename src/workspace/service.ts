import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import { logger } from '../logger.js'
import { loadRegistry, upsertWorkspace, workspaceDir, identity, getWorkspace } from './registry.js'
import { runWorkspaceSync } from './sync.js'
import type { WorkspaceSyncResult } from './sync.js'
import { makeSyncIO, readPrivatePatterns } from './io.js'
import { parseWorkspaceManifest } from './manifest.js'
import type { WorkspaceEntry } from './types.js'

export type Notify = (text: string) => Promise<void>

export interface ServiceDeps {
  syncOne(entry: WorkspaceEntry): Promise<WorkspaceSyncResult>
  notify: Notify
  now?: () => number
  storeDir?: string
}

const FAILURE_THRESHOLD = 3
type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
const timers: TimerHandle[] = []

const LOG_DIR = resolve(PROJECT_ROOT, 'logs')
const LOG_FILE = resolve(LOG_DIR, 'workspace-sync.log')
function logLine(line: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${line}\n`)
  } catch {
    // logging must never break a sync
  }
}

/** Pure: fold one result into the entry and decide whether the owner hears about it. */
export function applySyncOutcome(
  entry: WorkspaceEntry,
  result: WorkspaceSyncResult,
  now: number
): { entry: WorkspaceEntry; notice: string | null } {
  const prevFailures = entry.failures ?? 0
  const failures = result.ok ? 0 : prevFailures + 1
  const next: WorkspaceEntry = { ...entry, failures, lastSyncAt: now, lastSyncOk: result.ok, lastSyncMessage: result.message }
  const lines: string[] = []

  if (result.conflict) {
    lines.push(`Workspace "${entry.name}": merge conflict in ${result.conflict}. I left the markers in place; it needs a human.`)
  } else if (!result.ok && failures === FAILURE_THRESHOLD) {
    lines.push(`Workspace "${entry.name}": sync has failed ${FAILURE_THRESHOLD} times in a row (${result.message}). I will stay quiet until it recovers.`)
  } else if (result.ok && prevFailures >= FAILURE_THRESHOLD) {
    lines.push(`Workspace "${entry.name}": sync recovered.`)
  }
  if (result.unstaged.length > 0) {
    const held = result.unstaged.map((u) => `${u.path} (${u.reason})`).join(', ')
    lines.push(`Workspace "${entry.name}": held back ${held}. Not pushed.`)
  }
  return { entry: next, notice: lines.length ? lines.join('\n') : null }
}

/** Default syncOne: real git in the clone dir. */
export async function defaultSyncOne(entry: WorkspaceEntry): Promise<WorkspaceSyncResult> {
  const dir = workspaceDir(entry)
  const { assistant } = identity()
  const io = makeSyncIO(dir, (l) => logLine(`[${entry.name}] ${l}`))
  const result = await runWorkspaceSync(io, { assistant, privatePatterns: readPrivatePatterns() })
  const raw = io.readFile('WORKSPACE.md')
  if (raw) entry.manifest = parseWorkspaceManifest(raw, entry.name)
  return result
}

export async function syncNow(name: string, deps: ServiceDeps): Promise<WorkspaceSyncResult> {
  const entry = getWorkspace(name, deps.storeDir)
  if (!entry) return { ok: false, message: `no workspace named "${name}"`, unstaged: [], committed: false, pushed: false }
  return runOne(entry, deps)
}

async function runOne(entry: WorkspaceEntry, deps: ServiceDeps): Promise<WorkspaceSyncResult> {
  const now = deps.now ? deps.now() : Date.now()
  let result: WorkspaceSyncResult
  try {
    result = await deps.syncOne(entry)
  } catch (err) {
    result = { ok: false, message: String(err), unstaged: [], committed: false, pushed: false }
  }
  logLine(`[${entry.name}] ${result.ok ? 'ok' : 'FAIL'}: ${result.message}`)
  const { entry: next, notice } = applySyncOutcome(entry, result, now)
  upsertWorkspace(next, deps.storeDir)
  if (notice) await deps.notify(notice).catch((err) => logger.warn({ err }, 'workspace notify failed'))
  return result
}

/**
 * One interval per enabled workspace, first run staggered by two minutes per
 * workspace so two clones on one box never sync in the same minute.
 */
export function initWorkspaceService(deps: ServiceDeps): void {
  const entries = loadRegistry(deps.storeDir).filter((w) => w.enabled)
  entries.forEach((entry, i) => {
    const every = Math.max(1, entry.syncMinutes || 30) * 60_000
    const first = setTimeout(() => {
      const fresh = getWorkspace(entry.name, deps.storeDir)
      if (fresh && fresh.enabled) {
        runOne(fresh, deps).catch((err) => logger.error({ err }, 'workspace sync failed'))
      }
      timers.push(setInterval(() => {
        const fresh = getWorkspace(entry.name, deps.storeDir)
        if (!fresh || !fresh.enabled) return
        runOne(fresh, deps).catch((err) => logger.error({ err }, 'workspace sync failed'))
      }, every))
    }, i * 2 * 60_000 + 15_000)
    timers.push(first)
  })
  if (entries.length) logger.info({ count: entries.length }, 'Workspace sync service started')
}

export function stopWorkspaceService(): void {
  for (const t of timers) {
    clearTimeout(t)
    clearInterval(t)
  }
  timers.length = 0
}
