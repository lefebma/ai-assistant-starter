/**
 * The 30-day usage digest behind /audit.
 *
 * The point of the audit is to tell an owner something true about how they use
 * their assistant, so the numbers have to come from the box's own records
 * rather than from the model's impression of the conversation. This module
 * collects those records; the model's job starts after it, in report.ts.
 *
 * **Where the facts come from, and what each one cannot see:**
 *
 * - **Turns** come from the `memories` table, the `User said: ...` rows that
 *   saveConversationTurn() writes. That is the only durable record of what was
 *   asked: there is no message log. It undercounts, and the report says so.
 *   Messages of 20 characters or fewer are never saved, slash commands are
 *   never saved, and an identical question repeated inside the same stretch of
 *   conversation is saved once. Decay deletes a memory after roughly 114 days
 *   untouched, which is well clear of a 30-day window.
 * - **Skill use** is counted by running each recorded turn back through the
 *   production trigger matcher, not through a second keyword list invented
 *   here. If the count is wrong, it is wrong in exactly the way the live
 *   routing is wrong, which is the useful kind of wrong.
 * - **Token usage** only exists on the ai-sdk runtime. The default claude
 *   runtime bills through the owner's subscription and writes no usage_log, so
 *   on most installs this is absent rather than zero, and the difference
 *   matters enough to carry a flag.
 *
 * Everything is bucketed in the install's timezone. A hosted box runs on UTC
 * while its owner lives in Toronto, so `date(ts,'unixepoch','localtime')`
 * would put their 9pm questions on the following morning and quietly invent a
 * night owl.
 */
import { redactSensitive } from '../support/redact.js'

/** How far back an audit looks by default. */
export const DEFAULT_WINDOW_DAYS = 30

/** Prefix saveConversationTurn() puts on the user half of a turn. */
export const MEMORY_TURN_PREFIX = 'User said: '

/** Most turns quoted back to the model. Enough to see a shape, not a transcript. */
export const SAMPLE_LIMIT = 60

/** Characters kept per quoted turn. Long enough to tell what was asked. */
export const SAMPLE_CHARS = 160

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/**
 * Turn framings the bot writes on the owner's behalf, which are not requests.
 *
 * A button tap arrives as `[button_click]: Send`. Counting those as questions
 * inflates the volume and fills the sample with the word "Send". A voice
 * transcription is the opposite case and is kept: it is a real request, and
 * the marker tells the report that this owner talks to their assistant.
 */
const NON_REQUEST_PREFIXES = ['[button_click]:']

/** Absolute filesystem paths, POSIX and Windows, but never inside a URL. */
const PATH_RE = /(?<![\w:/])(?:\/(?:Users|home|var|tmp|private|opt|srv|mnt)\/[^\s\]]*|[A-Za-z]:\\[^\s\]]*)/g

/** True when a recorded turn is something the owner actually asked for. */
export function isRequestTurn(text: string): boolean {
  return !NON_REQUEST_PREFIXES.some((p) => text.startsWith(p))
}

/**
 * Replace filesystem paths with a marker.
 *
 * An uploaded photo is recorded as `[Photo attached: /Users/jane/...]`, so the
 * owner's account name and directory layout sit in the memories table and would
 * otherwise be quoted straight back into a report they might forward. The path
 * carries nothing the report needs: that a photo was sent is the whole signal.
 */
export function scrubPaths(text: string): string {
  return text.replace(PATH_RE, '[path]')
}

export interface AuditTurn {
  /** Epoch seconds. */
  at: number
  /** What the owner said, prefix already stripped. */
  text: string
}

export interface AuditTaskRow {
  name: string
  schedule: string
  status: string
  /** Epoch seconds, or null when it has never run. */
  lastRun: number | null
}

export interface TokenUsage {
  /** False on the claude runtime, which records nothing. Not the same as zero. */
  available: boolean
  runs: number
  totalTokens: number
  models: string[]
}

export interface GoalState {
  /** The discovery interview has replaced the scaffolded stub. */
  profileWritten: boolean
  /** That profile actually names priorities, rather than leaving the section empty. */
  prioritiesRecorded: boolean
}

export interface SkillUse {
  id: string
  name: string
  turns: number
}

export interface DayCount {
  day: string
  turns: number
}

export interface HourCount {
  hour: number
  turns: number
}

export interface WeekdayCount {
  weekday: string
  turns: number
}

/** Injected boundary, so a test never needs a database or a real install. */
export interface AuditIO {
  /** Recorded turns for this chat inside the window, oldest first. */
  turns(chatId: string, sinceSecs: number): AuditTurn[]
  /** Scheduled work belonging to this chat. */
  tasks(chatId: string): AuditTaskRow[]
  enabledSkills(): { id: string; name: string }[]
  /** Skill ids whose triggers fire on this text. */
  matchTurn(text: string): string[]
  tokenUsage(sinceSecs: number): TokenUsage
  goals(): GoalState
  /** Epoch seconds. */
  now(): number
  timeZone(): string
}

export interface AuditDigest {
  windowDays: number
  /** ISO instant the digest was taken. */
  generatedAt: string
  timeZone: string
  recordedTurns: number
  activeDays: number
  /** Days with at least one recorded turn, oldest first. */
  perDay: DayCount[]
  /** Hours that saw a turn, busiest first. */
  byHour: HourCount[]
  /** All seven, Monday first, zeros included: a silent weekend is a finding. */
  byWeekday: WeekdayCount[]
  /** Whole days with nothing, measured only after the first recorded turn. */
  longestQuietRunDays: number
  firstTurn: string | null
  lastTurn: string | null
  samples: string[]
  /** True when samples are a subset of the turns. */
  samplesTruncated: boolean
  skillsUsed: SkillUse[]
  skillsUnused: SkillUse[]
  tasks: AuditTaskRow[]
  tokens: TokenUsage
  goals: GoalState
}

export interface AuditOptions {
  windowDays?: number
}

/** Drop the memory row prefix. Rows written by other paths pass through. */
export function parseTurnContent(content: string): string {
  return content.startsWith(MEMORY_TURN_PREFIX) ? content.slice(MEMORY_TURN_PREFIX.length) : content
}

export interface LocalStamp {
  /** YYYY-MM-DD in the install's timezone. */
  day: string
  hour: number
  /** Three-letter English weekday. */
  weekday: string
}

/**
 * Wall-clock parts of an instant in a given zone. hourCycle h23 rather than
 * hour12:false, which renders midnight as 24 on some ICU builds.
 */
export function localStamp(atSecs: number, timeZone: string): LocalStamp {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(atSecs * 1000))

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    weekday: get('weekday'),
  }
}

/** Calendar day as a day number, for gap arithmetic that never touches a clock. */
function dayIndex(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000)
}

/**
 * Longest run of whole days with nothing on them, from the first active day
 * through `throughDay`. Silence before the first recorded turn is not the owner
 * ignoring their assistant, it is the assistant not existing yet, so it is
 * never counted.
 */
export function longestQuietRun(activeDays: string[], throughDay: string): number {
  if (activeDays.length === 0) return 0
  const idx = [...new Set(activeDays)].map(dayIndex).sort((a, b) => a - b)
  let longest = 0
  for (let i = 1; i < idx.length; i++) {
    longest = Math.max(longest, idx[i]! - idx[i - 1]! - 1)
  }
  return Math.max(longest, dayIndex(throughDay) - idx[idx.length - 1]! - 1, 0)
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}...` : text
}

/**
 * A readable sample of what was asked, spread evenly across the window.
 *
 * Taking the first N would describe the oldest week of the month and call it
 * the month. Redaction runs on the way out: a key pasted into a chat is sitting
 * in the memories table, and a report is something an owner might forward.
 */
export function sampleTurns(
  turns: AuditTurn[],
  limit: number,
  chars: number
): { samples: string[]; truncated: boolean } {
  if (turns.length === 0) return { samples: [], truncated: false }
  const truncated = turns.length > limit
  const stride = truncated ? turns.length / limit : 1
  const picked: AuditTurn[] = []
  for (let i = 0; picked.length < Math.min(limit, turns.length); i++) {
    const idx = Math.floor(i * stride)
    if (idx >= turns.length) break
    picked.push(turns[idx]!)
  }
  return {
    samples: picked.map((t) => clip(scrubPaths(redactSensitive(t.text)), chars)),
    truncated,
  }
}

export function collectAudit(chatId: string, io: AuditIO, opts: AuditOptions = {}): AuditDigest {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS
  const now = io.now()
  const timeZone = io.timeZone()
  const turns = io.turns(chatId, now - windowDays * 86400).filter((t) => isRequestTurn(t.text))

  const perDayCounts = new Map<string, number>()
  const hourCounts = new Map<number, number>()
  const weekdayCounts = new Map<string, number>()
  for (const t of turns) {
    const { day, hour, weekday } = localStamp(t.at, timeZone)
    perDayCounts.set(day, (perDayCounts.get(day) ?? 0) + 1)
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1)
    weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1)
  }

  // Enabled skills only. A trigger can match a skill the owner has since
  // disabled, and reporting one as "used" would send them looking for it.
  const enabled = io.enabledSkills()
  const enabledIds = new Set(enabled.map((s) => s.id))
  const skillCounts = new Map<string, number>()
  for (const t of turns) {
    for (const id of new Set(io.matchTurn(t.text))) {
      if (enabledIds.has(id)) skillCounts.set(id, (skillCounts.get(id) ?? 0) + 1)
    }
  }
  const withCounts = enabled.map((s) => ({ ...s, turns: skillCounts.get(s.id) ?? 0 }))

  const sampled = sampleTurns(turns, SAMPLE_LIMIT, SAMPLE_CHARS)

  const perDay = [...perDayCounts.entries()]
    .map(([day, count]) => ({ day, turns: count }))
    .sort((a, b) => a.day.localeCompare(b.day))
  const today = localStamp(now, timeZone).day

  return {
    windowDays,
    generatedAt: new Date(now * 1000).toISOString(),
    timeZone,
    recordedTurns: turns.length,
    activeDays: perDay.length,
    perDay,
    byHour: [...hourCounts.entries()]
      .map(([hour, count]) => ({ hour, turns: count }))
      .sort((a, b) => b.turns - a.turns || a.hour - b.hour),
    byWeekday: WEEKDAYS.map((weekday) => ({ weekday, turns: weekdayCounts.get(weekday) ?? 0 })),
    longestQuietRunDays: longestQuietRun(perDay.map((d) => d.day), today),
    firstTurn: turns.length > 0 ? new Date(turns[0]!.at * 1000).toISOString() : null,
    lastTurn: turns.length > 0 ? new Date(turns[turns.length - 1]!.at * 1000).toISOString() : null,
    samples: sampled.samples,
    samplesTruncated: sampled.truncated,
    skillsUsed: withCounts
      .filter((s) => s.turns > 0)
      .sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id)),
    skillsUnused: withCounts.filter((s) => s.turns === 0).sort((a, b) => a.id.localeCompare(b.id)),
    tasks: io.tasks(chatId),
    tokens: io.tokenUsage(now - windowDays * 86400),
    goals: io.goals(),
  }
}
