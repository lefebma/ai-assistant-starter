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

export interface CalEvent {
  id: string
  subject: string
  /** Local wall-clock as Graph returns it, no trailing zeros. */
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
}

interface RawEvent {
  id?: string
  subject?: string
  start?: { dateTime?: string }
  end?: { dateTime?: string }
  location?: { displayName?: string }
  isAllDay?: boolean
}

/** Graph pads to seven decimal places; nobody needs that. */
function trimStamp(s: string | undefined): string {
  return (s ?? '').replace(/\.\d+$/, '')
}

function toEvent(e: RawEvent): CalEvent {
  return {
    id: e.id ?? '',
    subject: e.subject ?? '(no subject)',
    start: trimStamp(e.start?.dateTime),
    end: trimStamp(e.end?.dateTime),
    location: e.location?.displayName ?? '',
    allDay: e.isAllDay === true,
  }
}

export async function eventsInRange(
  client: GraphLike,
  startDate: string,
  endDate: string,
  timeZone: string
): Promise<CalEvent[]> {
  const path =
    `/me/calendarView?startDateTime=${encodeURIComponent(startDate)}` +
    `&endDateTime=${encodeURIComponent(endDate)}` +
    `&$orderby=start/dateTime&$top=100`
  const res = (await client.get(path)) as { value?: RawEvent[] }
  void timeZone // carried by the Prefer header at the call site when one is set
  return (res.value ?? []).map(toEvent)
}

/** The day it currently is where the owner lives, not where the server is. */
function localDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1))
  return next.toISOString().slice(0, 10)
}

export async function eventsToday(
  client: GraphLike,
  timeZone: string,
  now: Date = new Date()
): Promise<CalEvent[]> {
  const today = localDay(now, timeZone)
  return eventsInRange(client, today, nextDay(today), timeZone)
}

export async function createEvent(client: GraphLike, input: NewEvent): Promise<{ id: string }> {
  if (input.end <= input.start) {
    throw new Error(`createEvent refused: end (${input.end}) is not after start (${input.start}).`)
  }
  const payload: Record<string, unknown> = {
    subject: input.subject,
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
  }
  if (input.location) payload['location'] = { displayName: input.location }
  if (input.body) payload['body'] = { contentType: 'Text', content: input.body }
  if (input.attendees?.length) {
    payload['attendees'] = input.attendees
      .filter((a) => a.trim())
      .map((a) => ({ emailAddress: { address: a.trim() }, type: 'required' }))
  }
  const res = (await client.post('/me/events', payload)) as { id?: string }
  return { id: res.id ?? '' }
}

export function renderEvents(events: CalEvent[]): string {
  if (events.length === 0) return 'Nothing on the calendar.'
  return events
    .map((e) => {
      const when = e.allDay ? 'all day' : `${e.start.slice(11, 16)}-${e.end.slice(11, 16)}`
      const where = e.location ? `  (${e.location})` : ''
      return `${when}  ${e.subject}${where}`
    })
    .join('\n')
}
