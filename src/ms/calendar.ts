/**
 * Outlook calendar through Graph.
 *
 * Reads go through /me/calendarView rather than /me/events. That is the whole
 * difference between a useful calendar and a confusing one: /me/events returns
 * the recurring master, so a weekly standup appears once on the day the series
 * was created and never again, while calendarView expands occurrences across
 * the window asked for.
 */
import type { GraphLike } from './mail.js'
import { isDay, localDay, localMidnight, nextDay, utcToLocal } from './time.js'

export interface CalEvent {
  id: string
  subject: string
  /** Owner's wall clock, YYYY-MM-DDTHH:MM:SS. */
  start: string
  end: string
  location: string
  allDay: boolean
}

export interface NewEvent {
  subject: string
  /** Local wall clock, e.g. 2026-09-20T10:00 */
  start: string
  end: string
  timeZone: string
  attendees?: string[]
  location?: string
  body?: string
  /**
   * Outlook mails every attendee the moment the event exists, and that cannot
   * be taken back. Same rule as sending mail: say so at the call site.
   */
  invitesApproved?: boolean
}

interface RawEvent {
  id?: string
  subject?: string
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  location?: { displayName?: string }
  isAllDay?: boolean
}

const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/**
 * Graph answers in UTC when no zone is asked for. An all-day event is the
 * exception: it is a date, not an instant, and shifting its midnight into
 * Toronto would move a holiday to 8pm the evening before.
 */
function toLocal(t: { dateTime?: string; timeZone?: string } | undefined, allDay: boolean, timeZone: string): string {
  const raw = (t?.dateTime ?? '').replace(/\.\d+$/, '')
  const zone = t?.timeZone ?? 'UTC'
  if (allDay || zone !== 'UTC') return raw
  return utcToLocal(raw, timeZone)
}

function toEvent(e: RawEvent, timeZone: string): CalEvent {
  const allDay = e.isAllDay === true
  return {
    id: e.id ?? '',
    subject: e.subject ?? '(no subject)',
    start: toLocal(e.start, allDay, timeZone),
    end: toLocal(e.end, allDay, timeZone),
    location: e.location?.displayName ?? '',
    allDay,
  }
}

/**
 * Every event from the start of `firstDay` to the end of `lastDay`, both
 * inclusive and both in the owner's zone.
 */
export async function eventsInRange(
  client: GraphLike,
  firstDay: string,
  lastDay: string,
  timeZone: string
): Promise<CalEvent[]> {
  for (const d of [firstDay, lastDay]) {
    if (!isDay(d)) throw new Error(`Expected a date like 2026-09-20, got "${d}".`)
  }
  if (lastDay < firstDay) throw new Error(`The range ends (${lastDay}) before it starts (${firstDay}).`)
  const path =
    `/me/calendarView?startDateTime=${encodeURIComponent(localMidnight(firstDay, timeZone))}` +
    `&endDateTime=${encodeURIComponent(localMidnight(nextDay(lastDay), timeZone))}` +
    `&$orderby=start/dateTime&$top=100`
  const res = (await client.get(path)) as { value?: RawEvent[] }
  return (res.value ?? []).map((e) => toEvent(e, timeZone))
}

export async function eventsToday(
  client: GraphLike,
  timeZone: string,
  now: Date = new Date()
): Promise<CalEvent[]> {
  const today = localDay(now, timeZone)
  return eventsInRange(client, today, today, timeZone)
}

export async function createEvent(client: GraphLike, input: NewEvent): Promise<{ id: string }> {
  for (const t of [input.start, input.end]) {
    if (!LOCAL_STAMP.test(t)) throw new Error(`Expected a time like 2026-09-20T10:00, got "${t}".`)
  }
  if (input.end <= input.start) {
    throw new Error(`createEvent refused: end (${input.end}) is not after start (${input.start}).`)
  }
  const attendees = (input.attendees ?? []).map((a) => a.trim()).filter(Boolean)
  if (attendees.length && !input.invitesApproved) {
    throw new Error(
      'createEvent refused: attendees are emailed an invitation the moment the event exists. ' +
        'That needs explicit approval, or create it without attendees.'
    )
  }
  const payload: Record<string, unknown> = {
    subject: input.subject,
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
  }
  if (input.location) payload['location'] = { displayName: input.location }
  if (input.body) payload['body'] = { contentType: 'Text', content: input.body }
  if (attendees.length) {
    payload['attendees'] = attendees.map((a) => ({ emailAddress: { address: a }, type: 'required' }))
  }
  const res = (await client.post('/me/events', payload)) as { id?: string }
  return { id: res.id ?? '' }
}

function line(e: CalEvent): string {
  const when = e.allDay ? 'all day' : `${e.start.slice(11, 16)}-${e.end.slice(11, 16)}`
  const where = e.location ? `  (${e.location})` : ''
  return `${when}  ${e.subject}${where}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayHeading(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]} ${day}`
}

/**
 * A heading per day whenever the question covered more than one day. Keyed
 * on the question, not the answer: a week with a single appointment in it
 * still has to say which day that appointment is on.
 */
export function renderEvents(events: CalEvent[], dated = false): string {
  if (events.length === 0) return 'Nothing on the calendar.'
  const days = [...new Set(events.map((e) => e.start.slice(0, 10)))]
  if (!dated && days.length === 1) return events.map(line).join('\n')
  return days
    .map((d) =>
      [dayHeading(d), ...events.filter((e) => e.start.slice(0, 10) === d).map((e) => `  ${line(e)}`)].join('\n')
    )
    .join('\n')
}
