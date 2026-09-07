import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import { logger } from '../logger.js'
import { loadRegistry, upsertWorkspace, workspaceDir, identity, getWorkspace } from './registry.js'
import { runWorkspaceSync } from './sync.js'
import type { WorkspaceSyncResult } from './sync.js'
import { makeSyncIO, privatePatternsPath, readPrivatePatterns } from './io.js'
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
/** One entry per scheduled workspace, so join and leave can move one alone. */
const timers = new Map<string, TimerHandle[]>()

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

/**
 * Pure: fold one result into the entry and decide whether the owner hears
 * about it. Every notice is once-only. The failure counter notifies on the
 * third failure and on recovery; a conflict notifies when the conflicting path
 * changes and when it clears; held-back files notify when the set changes.
 * Without that, one unresolved conflict or one private-pattern hit means a
 * message every syncMinutes forever, because the file is re-staged and
 * re-dropped on every run.
 */
export function applySyncOutcome(
  entry: WorkspaceEntry,
  result: WorkspaceSyncResult,
  now: number
): { entry: WorkspaceEntry; notice: string | null } {
  const prevFailures = entry.failures ?? 0
  const failures = result.ok ? 0 : prevFailures + 1
  const held = [...new Set(result.unstaged.map((u) => u.path))].sort()
  const prevHeld = entry.lastHeldBack ?? []
  const heldChanged = held.length !== prevHeld.length || held.some((p, i) => p !== prevHeld[i])

  const next: WorkspaceEntry = {
    ...entry,
    failures,
    lastSyncAt: now,
    lastSyncOk: result.ok,
    lastSyncMessage: result.message,
    lastConflict: result.conflict,
    lastHeldBack: held,
  }
  const lines: string[] = []

  if (result.conflict) {
    if (result.conflict !== entry.lastConflict) {
      lines.push(`Workspace "${entry.name}": merge conflict in ${result.conflict}. I left the markers in place; it needs a human.`)
    }
  } else if (entry.lastConflict) {
    lines.push(`Workspace "${entry.name}": conflict resolved.`)
  }

  if (!result.ok && failures === FAILURE_THRESHOLD) {
    lines.push(`Workspace "${entry.name}": sync has failed ${FAILURE_THRESHOLD} times in a row (${result.message}). I will stay quiet until it recovers.`)
  } else if (result.ok && prevFailures >= FAILURE_THRESHOLD) {
    lines.push(`Workspace "${entry.name}": sync recovered.`)
  }

  if (held.length > 0 && heldChanged) {
    const names = result.unstaged.map((u) => `${u.path} (${u.reason})`).join(', ')
    lines.push(`Workspace "${entry.name}": held back ${names}. Not pushed.`)
  }
  return { entry: next, notice: lines.length ? lines.join('\n') : null }
}

/** Warn once per process, not once per sync, when the pattern file is absent. */
let warnedNoPatterns = false

/** Default syncOne: real git in the clone dir. */
export async function defaultSyncOne(entry: WorkspaceEntry): Promise<WorkspaceSyncResult> {
  const dir = workspaceDir(entry)
  const { assistant } = identity()
  const io = makeSyncIO(dir, (l) => logLine(`[${entry.name}] ${l}`))
  const { patterns, present } = readPrivatePatterns()
  if (!present && !warnedNoPatterns) {
    warnedNoPatterns = true
    const msg = `workspaces/.private-patterns is missing, the private-pattern guard is doing nothing (${privatePatternsPath()})`
    logger.warn(msg)
    logLine(msg)
  }
  const result = await runWorkspaceSync(io, { assistant, privatePatterns: patterns })
  const raw = io.readFile('WORKSPACE.md')
  if (raw) entry.manifest = parseWorkspaceManifest(raw, entry.name)
  return result
}

export async function syncNow(name: string, deps: ServiceDeps): Promise<WorkspaceSyncResult> {
  const entry = getWorkspace(name, deps.storeDir)
  if (!entry) return { ok: false, message: `no workspace named "${name}"`, unstaged: [], committed: false, pushed: false }
  return runOne(entry, deps)
}

/**
 * One sync at a time per workspace. A timer tick that lands while a manual
 * /workspace sync is still running would otherwise drive two `git add -A` /
 * `git reset` sequences through one index: index.lock contention at best, one
 * run's guard drop racing the other's commit at worst.
 */
const inFlight = new Map<string, Promise<WorkspaceSyncResult>>()

function runOne(entry: WorkspaceEntry, deps: ServiceDeps): Promise<WorkspaceSyncResult> {
  const running = inFlight.get(entry.name)
  if (running) return running
  const p = runOneNow(entry, deps).finally(() => inFlight.delete(entry.name))
  inFlight.set(entry.name, p)
  return p
}

async function runOneNow(entry: WorkspaceEntry, deps: ServiceDeps): Promise<WorkspaceSyncResult> {
  const now = deps.now ? deps.now() : Date.now()
  let result: WorkspaceSyncResult
  try {
    result = await deps.syncOne(entry)
  } catch (err) {
    result = { ok: false, message: String(err), unstaged: [], committed: false, pushed: false }
  }
  logLine(`[${entry.name}] ${result.ok ? 'ok' : 'FAIL'}: ${result.message}`)
  const { entry: next, notice } = applySyncOutcome(entry, result, now)
  // A `leave` that landed mid-sync must stay left: writing the outcome back
  // would resurrect an entry pointing at a directory that no longer exists.
  if (!getWorkspace(entry.name, deps.storeDir)) {
    logLine(`[${entry.name}] left during sync, not writing the outcome back`)
    return result
  }
  upsertWorkspace(next, deps.storeDir)
  if (notice) await deps.notify(notice).catch((err) => logger.warn({ err }, 'workspace notify failed'))
  return result
}

/**
 * Put one workspace on a timer: a first run after `delayMs`, then every
 * syncMinutes. Re-scheduling the same name replaces its timers rather than
 * doubling them. Both callbacks re-read the registry, so a workspace disabled
 * or left in the meantime never syncs.
 */
export function scheduleWorkspace(entry: WorkspaceEntry, deps: ServiceDeps, delayMs = 15_000): void {
  unscheduleWorkspace(entry.name)
  const every = Math.max(1, entry.syncMinutes || 30) * 60_000
  const handles: TimerHandle[] = []
  timers.set(entry.name, handles)
  const tick = (): void => {
    const fresh = getWorkspace(entry.name, deps.storeDir)
    if (!fresh || !fresh.enabled) return
    runOne(fresh, deps).catch((err) => logger.error({ err }, 'workspace sync failed'))
  }
  handles.push(
    setTimeout(() => {
      tick()
      handles.push(setInterval(tick, every))
    }, delayMs)
  )
}

/** Take a workspace off its timer. Safe to call for a name that is not on one. */
export function unscheduleWorkspace(name: string): void {
  const handles = timers.get(name)
  if (!handles) return
  for (const t of handles) {
    clearTimeout(t)
    clearInterval(t)
  }
  timers.delete(name)
}

/**
 * One interval per enabled workspace, first run staggered by two minutes per
 * workspace so two clones on one box never sync in the same minute.
 */
export function initWorkspaceService(deps: ServiceDeps): void {
  const entries = loadRegistry(deps.storeDir).filter((w) => w.enabled)
  entries.forEach((entry, i) => scheduleWorkspace(entry, deps, i * 2 * 60_000 + 15_000))
  if (entries.length) logger.info({ count: entries.length }, 'Workspace sync service started')
}

export function stopWorkspaceService(): void {
  for (const name of [...timers.keys()]) unscheduleWorkspace(name)
}
