/**
 * The box's record of feature requests it sent (card #240): the per-box rate
 * limit, and the fallback file when no email account can send one.
 *
 * Only the reference and the time are kept in the log, never the words.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { RequestDraft } from './draft.js'

/** At most this many requests leave a box in any 24 hours, so a loop cannot flood the inbox. */
export const MAX_REQUESTS_PER_DAY = 5
const DAY_MS = 24 * 60 * 60 * 1000

interface LogEntry {
  ref: string
  at: string
}

function readLog(file: string): LogEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.ref === 'string' && typeof e.at === 'string') : []
  } catch {
    return []
  }
}

/** Requests sent from this box in the 24 hours before `now`. */
export function requestsInLastDay(file: string, now: Date = new Date()): number {
  const since = now.getTime() - DAY_MS
  return readLog(file).filter((e) => Date.parse(e.at) > since).length
}

export function canSendRequest(file: string, now: Date = new Date()): boolean {
  return requestsInLastDay(file, now) < MAX_REQUESTS_PER_DAY
}

/** Records a sent (or saved) request. Entries older than a day are dropped. */
export function recordRequest(file: string, ref: string, now: Date = new Date()): void {
  const since = now.getTime() - DAY_MS
  const kept = readLog(file).filter((e) => Date.parse(e.at) > since)
  kept.push({ ref, at: now.toISOString() })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 })
}

/** Fallback when the email cannot go out: the request as a file, so nothing is lost. */
export function saveFeatureRequest(draft: RequestDraft, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${draft.ref}.md`)
  writeFileSync(path, [`To: ${draft.to}`, `Subject: ${draft.subject}`, '', draft.body.trim(), ''].join('\n'), 'utf-8')
  return path
}
