/**
 * The proactive scan (card #258) and the pre-meeting briefing it sends
 * (card #259). Every INTERVAL_MS: read the connected calendars for the next
 * window, and for each meeting whose briefing time has come, find recent
 * mail with its attendees, ask the model whether anything is worth saying,
 * and either send a short briefing or record why it stayed quiet.
 *
 * Each meeting is decided once per kind (the row is unique on meeting and
 * kind), across restarts. A meeting that moves gets a new key and is decided
 * again. A decision to message is recorded before it is sent, so a failed or
 * interrupted send is retried on the next tick until the meeting starts.
 *
 * Quiet hours (the owner's one setting, shared with email alerts) hold
 * everything: a briefing due then is decided once they end, while the
 * meeting is still ahead, and one whose meeting starts before they end is
 * recorded as quiet with that reason. Nothing is read by the model in quiet
 * hours.
 *
 * Travel messages (card #260) ride the same tick: for a meeting at a
 * physical address, the trip is planned once when the meeting is within
 * PLAN_HORIZON_MS (and once more just before the message, for traffic), and
 * the message goes bufferMinutes before leave-by. They follow the same quiet
 * hours, decided-once rule and send retries as briefings.
 *
 * Read-only: nothing here replies, sends mail, accepts, declines or edits.
 * The only thing that leaves is the message, to the owner's own chat, and
 * the place and starting point sent to the maps source for a travel time.
 *
 * Log lines carry counts only, never a title, an attendee or a subject.
 */
import { logger } from '../logger.js'
import { aiPausedForBackground } from '../ai-limit.js'
import { upcomingEvents, type CalendarSource, type UpcomingEvent } from './calendar.js'
import type { RelatedThread } from './threads.js'
import type { DecideOutcome } from './decide.js'
import { formatBriefing, MAX_SHOWN, type FormatMode } from './format.js'
import { anyOn, getQuietHours, getSettings, quietUntil, type ProactiveSettings } from './settings.js'
import { createMapsClient, type MapsClient } from '../maps/client.js'
import {
  PLAN_HORIZON_MS,
  REFRESH_BEFORE_MS,
  formatTravel,
  inPersonPlace,
  planTrip,
  startingPoint,
  travelSendAt,
  type NotesOutcome,
  type Trip,
} from './travel.js'
import {
  coveredIds,
  dropPending,
  expirePending,
  isDecided,
  markCovered,
  markSent,
  pendingDecisions,
  getTrip,
  prune,
  recordDecision,
  saveTrip,
  recordSendFailure,
  type DecisionRow,
} from './store.js'

export const INTERVAL_MS = 10 * 60_000
export const TICK_CEILING_MS = 8 * 60_000
/** Started three minutes in, a minute after email alerts, so the two do not read mail at once. */
const FIRST_PASS_MS = 3 * 60_000
/** A briefing this close to the start is no longer useful and is not sent. */
export const MIN_BEFORE_MS = 5 * 60_000

export const QUIET_NO_ATTENDEES = 'No one else is invited.'
export const QUIET_NO_MAIL = 'No recent mail with the attendees.'
export const QUIET_NOTHING_NEW = 'Nothing new since the last briefing for this series.'
export const QUIET_HOURS = 'It fell in your quiet hours.'
export const QUIET_TOO_LATE = 'Seen too late to be any use.'
/** How far back the calendar is read when travel messages are on, to know where the owner comes from. */
const LOOKBACK_MS = 8 * 3_600_000

export interface TickDeps {
  calendars: () => Promise<CalendarSource[]>
  threads: (event: UpcomingEvent, ownAddress: string, nowMs: number) => Promise<RelatedThread[]>
  decide: (event: UpcomingEvent, threads: RelatedThread[]) => Promise<DecideOutcome>
  send: (text: string) => Promise<{ chatId: string; messageId: string } | null>
  now: () => Date
  tz: string
  format?: FormatMode
  /** Stops the tick between meetings once true (the run ceiling passed). */
  abandoned?: () => boolean
  /** Travel times (card #260). Defaults to the box's maps client, read fresh each tick. */
  maps?: () => MapsClient
  /** Arrival notes from mail for a travel message. Without it, travel messages carry none. */
  notes?: (event: UpcomingEvent, place: string, threads: RelatedThread[]) => Promise<NotesOutcome>
}

export interface TickResult {
  sent: number
  quiet: number
  decided: number
  failures: number
}

export function eventKey(e: UpcomingEvent): string {
  return `${e.provider}:${e.account}:${e.id}:${e.startMs}`
}

/** The briefing for this meeting is due: inside its lead time and not yet too late to help. */
export function briefingDue(e: UpcomingEvent, nowMs: number, leadMinutes: number): boolean {
  return nowMs >= e.startMs - leadMinutes * 60_000 && nowMs < e.startMs - MIN_BEFORE_MS
}

async function sendRow(deps: TickDeps, row: DecisionRow, nowMs: number): Promise<boolean> {
  let res: { chatId: string; messageId: string } | null = null
  try {
    res = await deps.send(row.text)
  } catch {
    res = null
  }
  if (res) {
    markSent(row.id, res.chatId, res.messageId, deps.now().getTime())
    return true
  }
  recordSendFailure(row.id, nowMs >= row.startMs - MIN_BEFORE_MS)
  return false
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const result: TickResult = { sent: 0, quiet: 0, decided: 0, failures: 0 }
  const settings = getSettings()
  if (!anyOn(settings)) return result
  const nowMs = deps.now().getTime()
  const stop = deps.abandoned ?? (() => false)
  // Set while in quiet hours: when they end.
  const quietEnd = quietUntil(nowMs, deps.tz, getQuietHours())
  const tooLateAfterQuiet = (startMs: number): boolean => quietEnd !== null && startMs - MIN_BEFORE_MS <= quietEnd

  prune(nowMs)
  // A briefing not out by MIN_BEFORE_MS ahead of its meeting is given up, unsent.
  expirePending(nowMs + MIN_BEFORE_MS)

  // 1. Briefings decided earlier whose send failed or was cut short.
  for (const row of pendingDecisions()) {
    if (stop()) return result
    if (quietEnd !== null) {
      if (tooLateAfterQuiet(row.startMs)) dropPending(row.id, QUIET_HOURS)
      continue
    }
    if (await sendRow(deps, row, nowMs)) result.sent++
    else result.failures++
  }

  // 2. Deciding needs the model; while the AI allowance is used up, briefings
  // wait. Travel messages need no model and go on, without arrival notes.
  const paused = aiPausedForBackground()
  if (paused && !settings.travel.on) {
    logger.info('AI allowance used up, proactive scan not run')
    return result
  }

  const sources = await deps.calendars()
  const own = new Map(sources.map((s) => [s.id, s.address]))
  const from = settings.travel.on ? nowMs - LOOKBACK_MS : nowMs
  const { events, failures } = await upcomingEvents(sources, from, nowMs + settings.windowHours * 3_600_000)
  result.failures += failures

  if (settings.travel.on) {
    const r = await travelPass(paused ? { ...deps, notes: undefined } : deps, settings, events, own, nowMs, quietEnd, stop)
    result.sent += r.sent
    result.quiet += r.quiet
    result.failures += r.failures
    if (r.stopped) return result
  }
  if (paused) {
    logger.info('AI allowance used up, briefings not decided')
    return result
  }

  for (const event of events) {
    if (stop()) break
    if (!settings.briefing.on || !briefingDue(event, nowMs, settings.briefing.leadMinutes)) continue
    const key = eventKey(event)
    if (isDecided(key, 'briefing')) continue
    const base = { eventKey: key, seriesKey: event.seriesKey, kind: 'briefing' as const, title: event.title, startMs: event.startMs, text: '', createdAt: nowMs }

    if (quietEnd !== null) {
      // Held: still due when quiet hours end, so the next tick after decides it.
      if (tooLateAfterQuiet(event.startMs) && recordDecision({ ...base, status: 'quiet', reason: QUIET_HOURS })) result.quiet++
      continue
    }

    if (event.attendees.length === 0) {
      if (recordDecision({ ...base, status: 'quiet', reason: QUIET_NO_ATTENDEES })) result.quiet++
      continue
    }

    let threads: RelatedThread[]
    try {
      threads = await deps.threads(event, own.get(event.account) ?? '', nowMs)
    } catch {
      result.failures++
      continue // read again next tick while still due
    }
    // A recurring meeting is briefed only on what its earlier briefings did not cover.
    const covered = coveredIds(event.seriesKey)
    threads = threads.filter((t) => t.messageIds.some((id) => !covered.has(id)))
    if (threads.length === 0) {
      const reason = covered.size > 0 ? QUIET_NOTHING_NEW : QUIET_NO_MAIL
      if (recordDecision({ ...base, status: 'quiet', reason })) result.quiet++
      continue
    }

    const outcome = await deps.decide(event, threads)
    if (outcome.kind === 'paused' || outcome.kind === 'capped') break
    if (outcome.kind === 'failed') {
      result.failures++
      continue // fails quiet; tried again next tick while still due
    }
    result.decided++
    const d = outcome.decision
    if (!d.brief) {
      if (recordDecision({ ...base, status: 'quiet', reason: d.reason || 'Nothing worth a message.' })) result.quiet++
      continue
    }
    const text = formatBriefing(event, d, deps.tz, deps.format)
    const id = recordDecision({ ...base, status: 'pending', reason: d.reason, text })
    if (id === null) continue // another tick decided it first
    const shownIds = [...d.picks.slice(0, MAX_SHOWN).map((p) => p.thread), ...d.owed.map((o) => o.thread)].flatMap(
      (t) => t.messageIds
    )
    const row: DecisionRow = {
      ...base,
      id,
      status: 'pending',
      reason: d.reason,
      text,
      attempts: 0,
      sentAt: null,
      chatId: null,
      chatMessageId: null,
    }
    if (await sendRow(deps, row, nowMs)) {
      markCovered(event.seriesKey, shownIds, nowMs)
      result.sent++
    } else {
      result.failures++
    }
  }

  if (result.sent || result.quiet || result.decided || result.failures) {
    logger.info({ ...result }, 'proactive tick')
  }
  return result
}

/**
 * Travel messages for in-person meetings. A trip is planned once the meeting
 * is within PLAN_HORIZON_MS, then looked up again once, close to the
 * message, for current traffic. The message goes at travelSendAt; one seen
 * after the meeting is nearly under way is recorded as too late.
 */
async function travelPass(
  deps: TickDeps,
  settings: ProactiveSettings,
  events: UpcomingEvent[],
  own: Map<string, string>,
  nowMs: number,
  quietEnd: number | null,
  stop: () => boolean
): Promise<{ sent: number; quiet: number; failures: number; stopped: boolean }> {
  const out = { sent: 0, quiet: 0, failures: 0, stopped: false }
  const maps = (deps.maps ?? (() => createMapsClient()))()
  const mapsOn = maps.mode !== 'off'
  for (const event of events) {
    if (stop()) {
      out.stopped = true
      return out
    }
    if (event.startMs <= nowMs || event.startMs - nowMs > PLAN_HORIZON_MS) continue
    const place = inPersonPlace(event, mapsOn)
    if (!place) continue
    const key = eventKey(event)
    if (isDecided(key, 'travel')) continue
    const base = { eventKey: key, seriesKey: event.seriesKey, kind: 'travel' as const, title: event.title, startMs: event.startMs, text: '', createdAt: nowMs }
    if (nowMs >= event.startMs - MIN_BEFORE_MS) {
      if (recordDecision({ ...base, status: 'quiet', reason: QUIET_TOO_LATE })) out.quiet++
      continue
    }

    const start = startingPoint(event, events, settings.travel.origin, mapsOn)
    let stored = getTrip<Trip>(key)
    if (!stored) {
      const trip = await planTrip(event, place, start, settings.travel.mode, maps, nowMs)
      saveTrip(key, trip, nowMs, false)
      stored = { trip, computedAt: nowMs, refreshed: false }
    } else if (!stored.refreshed && nowMs >= travelSendAt(event, stored.trip, settings.travel.bufferMinutes) - REFRESH_BEFORE_MS) {
      // Closer to the time, once: current traffic, or a second try (a starting
      // address set since, a maps hiccup). A failed lookup keeps the first answer.
      const fresh = await planTrip(event, place, start, settings.travel.mode, maps, nowMs)
      const trip = fresh.ok ? fresh : stored.trip
      saveTrip(key, trip, nowMs, true)
      stored = { trip, computedAt: nowMs, refreshed: true }
    }
    const trip = stored.trip
    if (nowMs < travelSendAt(event, trip, settings.travel.bufferMinutes)) continue

    if (quietEnd !== null) {
      if (quietEnd >= event.startMs - MIN_BEFORE_MS && recordDecision({ ...base, status: 'quiet', reason: QUIET_HOURS })) out.quiet++
      continue
    }

    let notes: string[] = []
    if (deps.notes && event.attendees.length > 0) {
      try {
        const threads = await deps.threads(event, own.get(event.account) ?? '', nowMs)
        const n = await deps.notes(event, place, threads)
        if (n.kind === 'notes') notes = n.notes
      } catch {
        // Notes are extra; the message goes without them.
      }
    }
    const text = formatTravel(event, place, trip, notes, {
      tz: deps.tz,
      mode: settings.travel.mode,
      nowMs,
      attribution: maps.attribution,
      format: deps.format,
    })
    const reason = trip.ok ? `About ${trip.minutes} min of travel.` : trip.why
    const id = recordDecision({ ...base, status: 'pending', reason, text })
    if (id === null) continue
    const row: DecisionRow = { ...base, id, status: 'pending', reason, text, attempts: 0, sentAt: null, chatId: null, chatMessageId: null }
    if (await sendRow(deps, row, nowMs)) out.sent++
    else out.failures++
  }
  return out
}

/**
 * First pass after FIRST_PASS_MS, then every INTERVAL_MS. Never overlaps,
 * never throws. A tick still running at TICK_CEILING_MS gives up the
 * overlap guard and stops before its next meeting.
 */
export function startProactive(deps: Omit<TickDeps, 'abandoned'>): () => void {
  let inFlight = false
  let stopped = false
  const run = async (): Promise<void> => {
    if (inFlight || stopped) return
    inFlight = true
    let abandoned = false
    let ceiling: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      ceiling = setTimeout(() => {
        abandoned = true
        resolve('timeout')
      }, TICK_CEILING_MS)
      ceiling.unref?.()
    })
    try {
      const outcome = await Promise.race([tick({ ...deps, abandoned: () => abandoned }).then(() => 'done' as const), timedOut])
      if (outcome === 'timeout') logger.warn({}, 'proactive tick timed out')
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'proactive tick failed')
    } finally {
      clearTimeout(ceiling)
      inFlight = false
    }
  }
  const first = setTimeout(() => void run(), FIRST_PASS_MS)
  const timer = setInterval(() => void run(), INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
