/**
 * Timing problems (card #261): what in the owner's calendar will bite if no
 * one notices. Three kinds:
 *
 * - Overlaps: two meetings the owner has accepted or not yet answered (the
 *   declined ones are already gone) that run into each other. A meeting
 *   marked free clashes with nothing.
 * - Tight back-to-backs: an in-person meeting straight after one somewhere
 *   else, with less time between them than the trip takes. The trip comes
 *   from the maps source, looked up once per pair. Without a travel time,
 *   only two street addresses with no gap at all count.
 * - Moved meetings: a meeting whose time or place changed since the owner
 *   last got a message about it.
 *
 * Each problem has a key (which meetings) and a signature (their times and
 * places). It is reported once per signature, so a change reports it again,
 * and once more when it is about to start (REMIND_BEFORE_MS) if the first
 * report was earlier than that.
 *
 * Read-only: it points the problem out and never moves, declines or
 * messages anyone. Nothing here logs a title or a place.
 */
import { createHash } from 'node:crypto'
import type { UpcomingEvent } from './calendar.js'
import type { FormatMode } from './format.js'
import type { TravelMode } from './settings.js'
import type { Seen } from './store.js'
import { BY, inPersonPlace, looksLikeAddress, md, previousMeeting } from './travel.js'

/** A problem first reported earlier than this before it starts is reported once more. */
export const REMIND_BEFORE_MS = 2 * 3_600_000

/** The meeting itself, whatever its start; its key in the decisions log includes the start. */
export function eventId(e: UpcomingEvent): string {
  return `${e.provider}:${e.account}:${e.id}`
}

export function samePlace(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

export interface Overlap {
  kind: 'overlap'
  a: UpcomingEvent
  b: UpcomingEvent
}

export interface BackToBack {
  kind: 'tight'
  a: UpcomingEvent
  b: UpcomingEvent
  from: string
  to: string
  gapMinutes: number
}

export interface Moved {
  kind: 'moved'
  e: UpcomingEvent
  was: Seen
}

/**
 * Meetings that run into each other, the later of the two still ahead and
 * the earlier starting before `untilMs`. `events` is soonest first.
 */
export function findOverlaps(events: UpcomingEvent[], nowMs: number, untilMs: number): Overlap[] {
  const busy = events.filter((e) => !e.free && e.endMs > e.startMs)
  const out: Overlap[] = []
  for (let i = 0; i < busy.length; i++) {
    const a = busy[i]!
    if (a.startMs > untilMs) break
    for (let j = i + 1; j < busy.length; j++) {
      const b = busy[j]!
      if (b.startMs >= a.endMs) break
      if (b.startMs <= nowMs) continue
      out.push({ kind: 'overlap', a, b })
    }
  }
  return out
}

/**
 * In-person meetings straight after one at another place: the candidates
 * for a trip longer than the gap. Whether the trip fits is for the caller,
 * which has the maps source.
 */
export function findBackToBacks(events: UpcomingEvent[], nowMs: number, untilMs: number, mapsOn: boolean): BackToBack[] {
  const out: BackToBack[] = []
  for (const b of events) {
    if (b.startMs <= nowMs || b.startMs > untilMs) continue
    const to = inPersonPlace(b, mapsOn)
    if (!to) continue
    const a = previousMeeting(b, events)
    const from = a ? inPersonPlace(a, mapsOn) : null
    if (!a || !from || samePlace(from, to)) continue
    out.push({ kind: 'tight', a, b, from, to, gapMinutes: Math.round((b.startMs - a.endMs) / 60_000) })
  }
  return out
}

/** Without a travel time, a back-to-back is only a problem with no gap between two street addresses. */
export function noGapBetweenAddresses(p: BackToBack): boolean {
  return p.gapMinutes <= 0 && looksLikeAddress(p.from) && looksLikeAddress(p.to)
}

/** Meetings still ahead whose time or place differs from the last message the owner got about them. */
export function findMoved(events: UpcomingEvent[], nowMs: number, untilMs: number, seen: (eventId: string) => Seen | null): Moved[] {
  const out: Moved[] = []
  for (const e of events) {
    if (e.startMs <= nowMs || e.startMs > untilMs) continue
    const was = seen(eventId(e))
    if (!was) continue
    if (was.startMs !== e.startMs || !samePlace(was.location, e.location)) out.push({ kind: 'moved', e, was })
  }
  return out
}

// ---------- keys ----------

export interface Found {
  /** Which meetings: stable while they move. */
  key: string
  /** Their times and places: a change reports the problem again. */
  sig: string
  /** When the problem bites: the clash begins, the first meeting ends, the moved one starts. */
  bitesMs: number
  events: UpcomingEvent[]
  /** Short, for the decisions log. */
  reason: string
  title: string
  text: string
  /** The text uses a travel time from the maps source, which must be credited. */
  usesMaps: boolean
}

export const REASON_OVERLAP = 'Overlap.'
export const REASON_TIGHT = 'Not enough travel time.'
export const REASON_NO_GAP = 'No gap between two addresses.'
export const REASON_MOVED = 'Moved.'

export function decisionKey(f: Pick<Found, 'key' | 'sig'>, reminder = false): string {
  const h = createHash('sha256').update(f.sig).digest('hex').slice(0, 12)
  return `timing:${f.key}@${h}${reminder ? '@soon' : ''}`
}

// ---------- the words ----------

export interface WordOpts {
  tz: string
  nowMs: number
  mode: TravelMode
  format?: FormatMode
}

function parts(ms: number, tz: string): { day: string; time: string; date: string } {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(new Date(ms))
  return {
    day: f({ weekday: 'short' }),
    time: f({ hour: '2-digit', minute: '2-digit', hour12: false }),
    date: f({ year: 'numeric', month: '2-digit', day: '2-digit' }),
  }
}

/** "14:00" today, "tomorrow 14:00", else "Tue 14:00". */
export function at(ms: number, o: Pick<WordOpts, 'tz' | 'nowMs'>): string {
  const p = parts(ms, o.tz)
  if (p.date === parts(o.nowMs, o.tz).date) return p.time
  if (p.date === parts(o.nowMs + 86_400_000, o.tz).date) return `tomorrow ${p.time}`
  return `${p.day} ${p.time}`
}

function span(e: UpcomingEvent, o: WordOpts): string {
  return `${at(e.startMs, o)} to ${parts(e.endMs, o.tz).time}`
}

function title2(a: UpcomingEvent, b: UpcomingEvent): string {
  return `${a.title} / ${b.title}`
}

export function describeOverlap(p: Overlap, o: WordOpts): Found {
  const esc = o.format === 'plain' ? (s: string) => s : md
  const [x, y] = [p.a, p.b].sort((m, n) => eventId(m).localeCompare(eventId(n)))
  return {
    key: `overlap:${eventId(x!)}|${eventId(y!)}`,
    sig: `${p.a.startMs}-${p.a.endMs}|${p.b.startMs}-${p.b.endMs}`,
    bitesMs: p.b.startMs,
    events: [p.a, p.b],
    reason: REASON_OVERLAP,
    title: title2(p.a, p.b),
    text: `${esc(p.a.title)} (${span(p.a, o)}) overlaps ${esc(p.b.title)} (${span(p.b, o)}).`,
    usesMaps: false,
  }
}

/** `minutes` is the trip's travel time, or null when there is none. */
export function describeBackToBack(p: BackToBack, minutes: number | null, o: WordOpts): Found {
  const esc = o.format === 'plain' ? (s: string) => s : md
  const gap = p.gapMinutes <= 0 ? 'with no gap' : `${p.gapMinutes} min later`
  const first = `${esc(p.a.title)} ends at ${at(p.a.endMs, o)} and ${esc(p.b.title)} starts ${gap}`
  const line =
    minutes === null
      ? `${first}, at a different address.`
      : `${first}, but the trip takes about ${minutes} min ${BY[o.mode]}.`
  return {
    key: `tight:${eventId(p.a)}>${eventId(p.b)}`,
    sig: `${p.a.endMs}|${p.b.startMs}|${norm(p.from)}|${norm(p.to)}`,
    bitesMs: p.a.endMs,
    events: [p.a, p.b],
    reason: minutes === null ? REASON_NO_GAP : REASON_TIGHT,
    title: title2(p.a, p.b),
    text: `${line}\nFrom ${esc(p.from)} to ${esc(p.to)}.`,
    usesMaps: minutes !== null,
  }
}

export function describeMoved(p: Moved, o: WordOpts): Found {
  const esc = o.format === 'plain' ? (s: string) => s : md
  const e = p.e
  const timeMoved = p.was.startMs !== e.startMs
  const placeMoved = !samePlace(p.was.location, e.location)
  const place = (s: string) => (s.trim() ? esc(s.trim()) : 'no place set')
  let text: string
  if (timeMoved && placeMoved) {
    text = `${esc(e.title)} moved to ${at(e.startMs, o)} at ${place(e.location)} (was ${at(p.was.startMs, o)} at ${place(p.was.location)}).`
  } else if (timeMoved) {
    text = `${esc(e.title)} moved to ${at(e.startMs, o)} (was ${at(p.was.startMs, o)}).`
  } else {
    text = e.location.trim()
      ? `${esc(e.title)} at ${at(e.startMs, o)} is now at ${place(e.location)} (was ${place(p.was.location)}).`
      : `${esc(e.title)} at ${at(e.startMs, o)} no longer has a place set (was ${place(p.was.location)}).`
  }
  return {
    key: `moved:${eventId(e)}`,
    sig: `${e.startMs}|${norm(e.location)}`,
    bitesMs: e.startMs,
    events: [e],
    reason: REASON_MOVED,
    title: e.title,
    text,
    usesMaps: false,
  }
}

/** A problem reported again as it comes up: the words for the decisions log and the message. */
export function asReminder(f: Found): Found {
  return { ...f, reason: `Reminder: ${f.reason}`, text: `Starting soon, still a problem: ${f.text}` }
}

/** One message for every problem decided in a pass. */
export function formatTiming(texts: string[], attribution: string | null): string {
  const body =
    texts.length === 1
      ? `Calendar check: ${texts[0]}`
      : ['Calendar check:', ...texts.map((t) => `- ${t.replace(/\n/g, '\n  ')}`)].join('\n')
  return attribution ? `${body}\n\n${attribution}` : body
}
