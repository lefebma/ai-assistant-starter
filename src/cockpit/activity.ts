import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

const ACTIVITY_LOG = resolve(homedir(), 'clawd/dashboard-data/activity.jsonl')

export type ActivityKind = 'cockpit' | 'telegram' | 'system'

export type ActivityEntry = {
  t: string                // ISO timestamp
  kind: ActivityKind
  summary: string
  skillId?: string
  runId?: string
}

export function readRecentActivity(limit = 50): ActivityEntry[] {
  if (!existsSync(ACTIVITY_LOG)) return []
  let text: string
  try { text = readFileSync(ACTIVITY_LOG, 'utf8') } catch { return [] }
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
  try {
    mkdirSync(dirname(ACTIVITY_LOG), { recursive: true })
    appendFileSync(ACTIVITY_LOG, JSON.stringify(row) + '\n')
  } catch {
    // best-effort; never throw from logging
  }
}
