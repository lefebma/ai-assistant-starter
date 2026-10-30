import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { MANAGED_AI_FILE, formatRenewDate, isManagedAi } from './ai-limit.js'
import { logger } from './logger.js'

/**
 * Month-to-date AI spend on a managed box (card #159). The total is the sum of
 * the cost the CLI reports on each result event, so it is an estimate; the
 * hard stop stays with the Anthropic workspace limit. Months are UTC calendar
 * months, matching when Anthropic resets a workspace limit.
 */
export const AI_USAGE_FILE = 'ai-usage.json'
export const WARN_FRACTION = 0.8

export interface AiUsage {
  /** UTC month, `YYYY-MM`. */
  month: string
  usd: number
  /** The part of `usd` that was maps calls through Havn's proxy (card #266). */
  mapsUsd?: number
  /** Copied from managed-ai.json on each write, so one read tells the whole story. */
  capUsd?: number
  /** When the owner was told about 80% this month, at the cap below. */
  warnedAt?: string
  /** The cap that heads-up was for; a new cap re-arms it. */
  warnedCapUsd?: number
}

export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7)
}

/** First moment of the next UTC month. */
export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

export function readManagedCap(storeDir: string = STORE_DIR): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, MANAGED_AI_FILE), 'utf8'))
    const cap = raw?.capUsd
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : undefined
  } catch {
    return undefined
  }
}

export function readAiUsage(storeDir: string = STORE_DIR): AiUsage | null {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, AI_USAGE_FILE), 'utf8'))
    if (!raw || typeof raw.month !== 'string' || typeof raw.usd !== 'number' || !Number.isFinite(raw.usd)) return null
    return raw as AiUsage
  } catch {
    return null
  }
}

function writeAiUsage(u: AiUsage, storeDir: string): void {
  mkdirSync(storeDir, { recursive: true })
  const target = join(storeDir, AI_USAGE_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(u, null, 2) + '\n')
  renameSync(tmp, target)
}

/** This month's usage, starting fresh when the stored month is over. */
function currentUsage(storeDir: string, now: Date): AiUsage {
  const month = utcMonth(now)
  const u = readAiUsage(storeDir)
  return u && u.month === month ? u : { month, usd: 0 }
}

/**
 * Add one call's cost. Never throws: metering must not break a turn. A
 * non-managed box, or a cost that is not a positive number, records nothing.
 */
export function recordManagedSpend(usd: unknown, opts: { storeDir?: string; now?: Date } = {}): void {
  const storeDir = opts.storeDir ?? STORE_DIR
  try {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return
    if (!isManagedAi(storeDir)) return
    const u = currentUsage(storeDir, opts.now ?? new Date())
    const cap = readManagedCap(storeDir)
    const next: AiUsage = { ...u, usd: Math.round((u.usd + usd) * 1e6) / 1e6 }
    if (cap !== undefined) next.capUsd = cap
    else delete next.capUsd
    writeAiUsage(next, storeDir)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not record AI spend')
  }
}

/**
 * Add one maps proxy call's cost (card #266). It goes into the same monthly
 * total as AI spend, so the 80% heads-up and the operator's spend line (#163,
 * which reads this file) include it, and is also kept apart as `mapsUsd`. The
 * hard stop for maps is the Worker's per-box quota, not the Anthropic limit.
 * Never throws; a non-managed box records nothing, as for AI spend.
 */
export function recordMapsSpend(usd: unknown, opts: { storeDir?: string; now?: Date } = {}): void {
  const storeDir = opts.storeDir ?? STORE_DIR
  try {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return
    if (!isManagedAi(storeDir)) return
    const u = currentUsage(storeDir, opts.now ?? new Date())
    const cap = readManagedCap(storeDir)
    const next: AiUsage = {
      ...u,
      usd: Math.round((u.usd + usd) * 1e6) / 1e6,
      mapsUsd: Math.round(((u.mapsUsd ?? 0) + usd) * 1e6) / 1e6,
    }
    if (cap !== undefined) next.capUsd = cap
    else delete next.capUsd
    writeAiUsage(next, storeDir)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not record maps spend')
  }
}

export function usageWarningText(now: Date): string {
  return (
    "Heads-up: I've used about 80% of this month's AI allowance. I'll keep working as normal. " +
    `If it runs out before it renews on ${formatRenewDate(nextUtcMonthStart(now))}, I'll pause until then. ` +
    'Your provider can raise it if you need more.'
  )
}

/**
 * The owner's one heads-up per month at 80% of the cap, or null. Calling it
 * does not mark anything; call markUsageWarned once the message is delivered.
 */
export function usageWarningDue(storeDir: string = STORE_DIR, now: Date = new Date()): string | null {
  if (!isManagedAi(storeDir)) return null
  const cap = readManagedCap(storeDir)
  const u = readAiUsage(storeDir)
  if (!cap || !u || u.month !== utcMonth(now)) return null
  if (u.warnedAt && u.warnedCapUsd === cap) return null
  // At or past the cap the box is about to pause (or the cap on record is
  // stale); "it may run out" would be wrong, and the pause message covers it.
  return u.usd >= cap * WARN_FRACTION && u.usd < cap ? usageWarningText(now) : null
}

/**
 * Copy a changed cap into this month's usage file straight away, so the
 * probe sees it without waiting for the next call. With no usage yet this
 * month there is nothing to update.
 */
export function syncUsageCap(storeDir: string = STORE_DIR, now: Date = new Date()): void {
  const u = readAiUsage(storeDir)
  if (!u || u.month !== utcMonth(now)) return
  const cap = readManagedCap(storeDir)
  const next: AiUsage = { ...u }
  if (cap !== undefined) next.capUsd = cap
  else delete next.capUsd
  writeAiUsage(next, storeDir)
}

export function markUsageWarned(storeDir: string = STORE_DIR, now: Date = new Date()): void {
  try {
    const u = currentUsage(storeDir, now)
    const cap = readManagedCap(storeDir)
    writeAiUsage({ ...u, warnedAt: now.toISOString(), ...(cap ? { warnedCapUsd: cap } : {}) }, storeDir)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not record the usage heads-up')
  }
}
