/**
 * The real-install side of the audit: SQLite, the skill loader, the filesystem.
 *
 * Kept apart from digest.ts so the arithmetic can be tested without a database
 * and so every query that reads conversation content sits in one file.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDb, getAllTasks } from '../db.js'
import { PROJECT_ROOT, installTimezone } from '../env.js'
import { getSkills, matchSkills } from '../skills/index.js'
import { UsageMeter } from '../metering.js'
import { logger } from '../logger.js'
import { profileIsUnwritten } from '../onboarding/interview-offer.js'
import { MEMORY_TURN_PREFIX, parseTurnContent, type AuditIO, type AuditTurn, type GoalState, type TokenUsage } from './digest.js'

/**
 * Whether a profile actually names priorities.
 *
 * A written profile with an empty priorities section is the common case after
 * an interview that got cut short, and it is the case that most needs the
 * audit to ask. Any heading starting with "Priorit" counts, because the
 * interview writes "## Priorities, next 90 days" but people edit these files
 * by hand.
 */
export function profileHasPriorities(markdown: string): boolean {
  const lines = markdown.split('\n')
  let inSection = false
  for (const raw of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim())
    if (heading) {
      inSection = /^priorit/i.test(heading[2] ?? '')
      continue
    }
    if (!inSection) continue
    const body = raw.trim()
    if (body && !body.startsWith('<!--')) return true
  }
  return false
}

function readGoals(): GoalState {
  const profileWritten = !profileIsUnwritten(PROJECT_ROOT)
  if (!profileWritten) return { profileWritten: false, prioritiesRecorded: false }
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, 'PROFILE.md'), 'utf-8')
    return { profileWritten: true, prioritiesRecorded: profileHasPriorities(raw) }
  } catch {
    return { profileWritten: true, prioritiesRecorded: false }
  }
}

function readTurns(chatId: string, sinceSecs: number): AuditTurn[] {
  const rows = getDb()
    .prepare(
      `SELECT content, created_at FROM memories
       WHERE chat_id = ? AND created_at >= ? AND content LIKE ?
       ORDER BY created_at ASC`
    )
    .all(chatId, sinceSecs, `${MEMORY_TURN_PREFIX}%`) as { content: string; created_at: number }[]
  return rows.map((r) => ({ at: r.created_at, text: parseTurnContent(r.content) }))
}

/**
 * Token counts, and the difference between "none" and "not measured".
 *
 * `available` asks whether this install has ever recorded a run at all, not
 * whether it recorded one this month. On the default claude runtime nothing is
 * ever written, and reporting that as zero usage would be a lie about the bill.
 */
function readTokenUsage(sinceSecs: number): TokenUsage {
  const empty: TokenUsage = { available: false, runs: 0, totalTokens: 0, models: [] }
  try {
    const db = getDb()
    const ever = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_log'`)
      .get()
    if (!ever) return empty
    const any = db.prepare('SELECT 1 FROM usage_log LIMIT 1').get()
    if (!any) return empty
    const rows = new UsageMeter(db).summary({ sinceSecs })
    return {
      available: true,
      runs: rows.reduce((sum, r) => sum + r.runs, 0),
      totalTokens: rows.reduce((sum, r) => sum + r.totalTokens, 0),
      models: [...new Set(rows.map((r) => r.model))].sort(),
    }
  } catch (err) {
    logger.warn({ err }, 'Audit could not read token usage')
    return empty
  }
}

export function defaultAuditIO(): AuditIO {
  return {
    turns: readTurns,
    tasks: (chatId) =>
      getAllTasks()
        .filter((t) => t.chat_id === chatId)
        .map((t) => ({
          name: t.name ?? t.prompt.slice(0, 60),
          schedule: t.schedule,
          status: t.status,
          lastRun: t.last_run,
        })),
    enabledSkills: () =>
      getSkills()
        .filter((s) => s.manifest.enabled)
        .map((s) => ({ id: s.manifest.id, name: s.manifest.name })),
    matchTurn: (text) => matchSkills(text).map((s) => s.manifest.id),
    tokenUsage: readTokenUsage,
    goals: readGoals,
    now: () => Math.floor(Date.now() / 1000),
    timeZone: installTimezone,
  }
}
