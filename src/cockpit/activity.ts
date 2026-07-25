import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dashboardDataFile } from './paths.js'

const activityLog = (): string | null => dashboardDataFile('activity.jsonl')

export type ActivityKind = 'cockpit' | 'telegram' | 'system'

export type ActivityEntry = {
  t: string                // ISO timestamp
  kind: ActivityKind
  summary: string
  skillId?: string
  runId?: string
}

export function readRecentActivity(limit = 50): ActivityEntry[] {
  const log = activityLog()
  if (!log || !existsSync(log)) return []
  let text: string
  try { text = readFileSync(log, 'utf8') } catch { return [] }
  const lines = text.split('\n').filter(Boolean)
  const tail = lines.slice(-limit)
  const out: ActivityEntry[] = []
  for (const line of tail) {
    try { out.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return out.reverse() // newest first
}

export function appendActivity(entry: Omit<ActivityEntry, 't'> & { t?: string }): void {
  const row: ActivityEntry = {
    t: entry.t ?? new Date().toISOString(),
    kind: entry.kind,
    summary: entry.summary,
    ...(entry.skillId ? { skillId: entry.skillId } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
  }
  const log = activityLog()
  if (!log) return // dashboard integration off
  try {
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, JSON.stringify(row) + '\n')
  } catch {
    // best-effort; never throw from logging
  }
}
