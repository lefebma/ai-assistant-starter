/**
 * "A new version is out" — said once, unprompted.
 *
 * Until now the only way to hear about a release was to ask, or to happen to
 * use a word the update context provider watches for (briefing, version,
 * status). Someone who never says those words runs an old build forever and
 * finds out by accident, which is how a fixed bug gets reported again.
 *
 * The rules, all here and all pure, because the timer around them is the easy
 * part and the judgement is not:
 *
 * - **Once per version.** Ignoring a release is a decision. The announcement
 *   is not repeated, and a box that has already announced 1.28.2 stays quiet
 *   about 1.28.2 forever, including across restarts.
 * - **Not in the middle of the night.** A push notification at 04:00 for
 *   something that can wait until morning is a reason to mute the assistant.
 * - **Not while a restart is already pending.** The owner has updated and has
 *   not restarted yet; telling them to update again is noise about work they
 *   have done.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'

/** Waking hours in the owner's timezone; outside them the notice waits. */
export const QUIET_BEFORE_HOUR = 8
export const QUIET_AFTER_HOUR = 21

/** What the last announcement was, so it is never made twice. */
export interface NoticeState {
  /** The version last announced to the owner, or '' if none ever was. */
  announced: string
  /** ISO stamp of that announcement, for anyone reading the file. */
  at?: string
}

export interface NoticeInput {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  /** Hour 0-23 in the owner's timezone. */
  localHour: number
  /** An update already applied and waiting for a restart. */
  restartPending: boolean
  state: NoticeState
}

export type NoticeDecision =
  | { announce: false; reason: string }
  | { announce: true; version: string }

/**
 * Whether to say something now. Every "no" carries its reason, so a box that
 * stays quiet can explain itself in the log rather than looking broken.
 */
export function decideNotice(input: NoticeInput): NoticeDecision {
  if (!input.updateAvailable || !input.latestVersion) return { announce: false, reason: 'no update available' }
  if (input.latestVersion === input.currentVersion) return { announce: false, reason: 'already on the latest' }
  if (input.state.announced === input.latestVersion) {
    return { announce: false, reason: `already announced ${input.latestVersion}` }
  }
  if (input.restartPending) return { announce: false, reason: 'an update is already waiting for a restart' }
  if (input.localHour < QUIET_BEFORE_HOUR || input.localHour >= QUIET_AFTER_HOUR) {
    return { announce: false, reason: `quiet hours (local hour ${input.localHour})` }
  }
  return { announce: true, version: input.latestVersion }
}

/**
 * The message. The changelog section starts with a one-line summary of the
 * release; that line is the whole point of telling someone, so it leads. The
 * rest stays behind `/update check`, because an unprompted message that runs
 * to twenty lines is one nobody reads.
 */
export function renderNotice(current: string, latest: string, changelog: string | null): string {
  const lines = [`Havn ${latest} is available. This box is on ${current}.`]
  const summary = summarise(changelog)
  if (summary) lines.push('', summary)
  lines.push('', 'Run /update apply to install it, or /update check to see everything in the release.')
  return lines.join('\n')
}

/**
 * First prose line of a changelog section: not the heading, not a bullet, not
 * a blank. A release whose section is only bullets has no summary line, and
 * gets none rather than a truncated bullet.
 */
function summarise(changelog: string | null): string | null {
  if (!changelog) return null
  for (const raw of changelog.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('*')) continue
    return line
  }
  return null
}

const STATE_FILE = resolve(PROJECT_ROOT, 'store', 'update-notice.json')

/**
 * Its own file rather than a field on the cached update status, which
 * applyUpdate rewrites wholesale: folding this in there would lose the record
 * of what was announced on the next update and announce it again.
 */
export function loadNoticeState(path: string = STATE_FILE): NoticeState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<NoticeState>
    return { announced: typeof parsed.announced === 'string' ? parsed.announced : '', at: parsed.at }
  } catch {
    // Absent or corrupt reads as "nothing announced yet". The cost of getting
    // this wrong is one duplicate message, never a missed one.
    return { announced: '' }
  }
}

export function saveNoticeState(state: NoticeState, path: string = STATE_FILE): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2))
  } catch {
    // A box with an unwritable store still works; it may repeat one notice.
  }
}

/** Hour 0-23 where the owner is, which is not where the server is. */
export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now)
  const parsed = Number(hour)
  return Number.isFinite(parsed) ? parsed : now.getUTCHours()
}
