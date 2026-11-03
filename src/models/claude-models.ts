/**
 * The effort levels the Claude CLI reports for its models (card #272).
 *
 * The claude runtime's tier aliases ('sonnet', 'opus', 'haiku') resolve to
 * whatever models the vendored CLI knows, so only the CLI can say which
 * effort levels they take. Every claude-runtime turn asks it once the query
 * has started (supportedModels) and this file keeps the answer in
 * store/claude-models.json, so /effort knows it after a restart too.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { STORE_DIR } from '../config.js'
import { EFFORTS, claudeEffortLevels, isEffort, type Effort } from './effort-levels.js'

type Recorded = { value: string; supportsEffort: boolean; levels: Effort[] }
type CacheFile = { recordedAt: number; models: Recorded[] }

/** What the SDK's supportedModels() returns, as far as effort goes. */
export type ReportedModel = { value: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }

function cachePath(): string {
  return resolve(STORE_DIR, 'claude-models.json')
}

let memo: { at: number; models: Recorded[] } | null = null

function readCache(): Recorded[] {
  if (memo) return memo.models
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile
    const models = Array.isArray(parsed.models) ? parsed.models : []
    memo = { at: parsed.recordedAt ?? 0, models }
    return models
  } catch {
    return []
  }
}

/** Keep the CLI's report. Never throws: a failed write only loses the hint. */
export function recordClaudeModels(models: ReportedModel[], now = Date.now()): void {
  try {
    const recorded: Recorded[] = models
      .filter((m) => typeof m?.value === 'string' && m.value)
      .map((m) => ({
        value: m.value,
        supportsEffort: Boolean(m.supportsEffort),
        levels: (m.supportedEffortLevels ?? []).filter(isEffort),
      }))
    if (!recorded.length) return
    const file = cachePath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ recordedAt: now, models: recorded } satisfies CacheFile))
    renameSync(tmp, file)
    memo = { at: now, models: recorded }
  } catch {
    /* the next turn tries again */
  }
}

/** Test seam: forget what was read, so the next lookup reads the file again. */
export function resetClaudeModelsMemo(): void {
  memo = null
}

/**
 * The levels the claude runtime's model takes: the CLI's report when it has
 * one for this model, else the Claude rule for a full id. A tier alias the
 * CLI has not reported yet offers every level; the CLI lowers a level its
 * model lacks.
 */
export function claudeRuntimeLevels(model: string): Effort[] {
  const m = model.trim()
  const reported = readCache().find((r) => r.value === m)
  if (reported) return reported.supportsEffort ? EFFORTS.filter((e) => reported.levels.includes(e)) : []
  return claudeEffortLevels(m) ?? [...EFFORTS]
}
