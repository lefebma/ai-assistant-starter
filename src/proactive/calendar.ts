/**
 * Upcoming events from every connected calendar: Google through gog, Outlook
 * through Graph. Both come back in one shape, with what the scan needs to
 * decide whether an event deserves a message: who is attending, whether the
 * owner is going, and where it is.
 *
 * Declined, cancelled and all-day events are dropped here. The same meeting
 * on two connected calendars (an invite sent to two of the owner's
 * addresses) is kept once, keyed by its iCal UID and start.
 *
 * No log line here carries a title, a location or an attendee.
 */
import { resolveGogBin } from '../infra/gog-bin.js'
import { readEnvFile } from '../env.js'
import type { GraphLike } from '../ms/mail.js'
import { defaultExec, parseGogAccounts, type Exec } from '../email-alerts/sources.js'

export interface Attendee {
  email: string
  name: string
}

export interface UpcomingEvent {
  /** The connected account the event was read from. */
  account: string
  provider: 'google' | 'outlook'
  id: string
  /** Same meeting on another calendar, and every occurrence of a series, share this. */
  seriesKey: string
  title: string
  startMs: number
  endMs: number
  location: string
  /** Everyone invited except the owner. */
  attendees: Attendee[]
  /** The owner organises it (alone or with others). */
  organizer: boolean
  link: string
}

const MAX_ATTENDEES = 12

function gogBin(): string {
  return resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
}

// ---------- Google ----------

interface GoogleAttendee {
  email?: string
  displayName?: string
  self?: boolean
  resource?: boolean
  responseStatus?: string
}
interface GoogleEvent {
  id?: string
  iCalUID?: string
  recurringEventId?: string
  status?: string
  summary?: string
  location?: string
  htmlLink?: string
  eventType?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: GoogleAttendee[]
  organizer?: { email?: string; self?: boolean }
}

export function parseGoogleEvents(stdout: string, account: string): UpcomingEvent[] {
  const parsed = JSON.parse(stdout) as GoogleEvent[] | { events?: GoogleEvent[] }
  const rows = Array.isArray(parsed) ? parsed : (parsed.events ?? [])
  const out: UpcomingEvent[] = []
  const own = account.trim().toLowerCase()
  for (const e of rows) {
    if (e.status === 'cancelled') continue
    if (!e.start?.dateTime || !e.end?.dateTime) continue // all-day
    if (e.eventType && e.eventType !== 'default') continue // focus time, out of office, working location
    const me = (e.attendees ?? []).find((a) => a.self || a.email?.toLowerCase() === own)
    if (me?.responseStatus === 'declined') continue
    const startMs = Date.parse(e.start.dateTime)
    const endMs = Date.parse(e.end.dateTime)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue
    const attendees = (e.attendees ?? [])
      .filter((a) => !a.self && !a.resource && a.email && a.email.toLowerCase() !== own)
      .slice(0, MAX_ATTENDEES)
      .map((a) => ({ email: a.email!.trim().toLowerCase(), name: (a.displayName ?? '').trim() }))
    out.push({
      account,
      provider: 'google',
      id: e.id ?? '',
      seriesKey: e.recurringEventId ?? e.iCalUID ?? e.id ?? '',
      title: (e.summary ?? '(no title)').trim(),
      startMs,
      endMs,
      location: (e.location ?? '').trim(),
      attendees,
      organizer: e.organizer?.self === true || e.organizer?.email?.toLowerCase() === own,
      link: e.htmlLink ?? '',
    })
  }
  return out
}

async function googleEvents(exec: Exec, account: string, fromMs: number, toMs: number): Promise<UpcomingEvent[]> {
  const r = await exec(gogBin(), [
    'calendar', 'events',
    '--from', new Date(fromMs).toISOString(),
    '--to', new Date(toMs).toISOString(),
    '--json', '--results-only', '--account', account,
  ])
  if (!r.ok) throw new Error('google calendar read failed')
  return parseGoogleEvents(r.stdout || '[]', account)
}

// ---------- Outlook ----------

interface GraphAttendee {
  type?: string
  emailAddress?: { name?: string; address?: string }
  status?: { response?: string }
}
interface GraphEvent {
  id?: string
  iCalUId?: string
  seriesMasterId?: string
  subject?: string
  isAllDay?: boolean
  isCancelled?: boolean
  isOrganizer?: boolean
  responseStatus?: { response?: string }
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
  location?: { displayName?: string }
  attendees?: GraphAttendee[]
  webLink?: string
  showAs?: string
}

const OUTLOOK_SELECT =
  'id,iCalUId,seriesMasterId,subject,isAllDay,isCancelled,isOrganizer,responseStatus,start,end,location,attendees,webLink,showAs'

/** Graph answers in UTC unless asked otherwise, without the Z. */
function graphInstant(t: { dateTime?: string; timeZone?: string } | undefined): number {
  const raw = (t?.dateTime ?? '').replace(/(\.\d{3})\d+$/, '$1')
  if (!raw) return Number.NaN
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`)
}

export function parseOutlookEvents(rows: GraphEvent[], account: string, own: string): UpcomingEvent[] {
  const me = own.trim().toLowerCase()
  const out: UpcomingEvent[] = []
  for (const e of rows) {
    if (e.isCancelled || e.isAllDay) continue
    if (e.responseStatus?.response === 'declined') continue
    if (e.showAs === 'oof') continue
    const startMs = graphInstant(e.start)
    const endMs = graphInstant(e.end)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue
    const attendees = (e.attendees ?? [])
      .filter((a) => a.type !== 'resource' && a.emailAddress?.address && a.emailAddress.address.toLowerCase() !== me)
      .slice(0, MAX_ATTENDEES)
      .map((a) => ({ email: a.emailAddress!.address!.trim().toLowerCase(), name: (a.emailAddress!.name ?? '').trim() }))
    out.push({
      account,
      provider: 'outlook',
      id: e.id ?? '',
      seriesKey: e.seriesMasterId ?? e.iCalUId ?? e.id ?? '',
      title: (e.subject ?? '(no title)').trim(),
      startMs,
      endMs,
      location: (e.location?.displayName ?? '').trim(),
      attendees,
      organizer: e.isOrganizer === true,
      link: e.webLink ?? '',
    })
  }
  return out
}

async function outlookEvents(
  client: GraphLike,
  account: string,
  own: string,
  fromMs: number,
  toMs: number
): Promise<UpcomingEvent[]> {
  const path =
    `/me/calendarView?startDateTime=${encodeURIComponent(new Date(fromMs).toISOString())}` +
    `&endDateTime=${encodeURIComponent(new Date(toMs).toISOString())}` +
    `&$orderby=start/dateTime&$top=100&$select=${OUTLOOK_SELECT}`
  const res = (await client.get(path)) as { value?: GraphEvent[] }
  return parseOutlookEvents(res.value ?? [], account, own)
}

// ---------- Discovery ----------

export interface CalendarSource {
  id: string
  provider: 'google' | 'outlook'
  /** The owner's address on this account, used to tell their own mail apart. */
  address: string
  events(fromMs: number, toMs: number): Promise<UpcomingEvent[]>
}

export interface CalendarDeps {
  exec?: Exec
  msAccounts?: () => string[]
  client?: (account: string) => GraphLike
}

/**
 * Every connected calendar. A side that fails to list its accounts is skipped
 * (the scan treats it as having no events this tick); it never throws.
 */
export async function discoverCalendars(deps: CalendarDeps): Promise<CalendarSource[]> {
  const exec = deps.exec ?? defaultExec
  const sources: CalendarSource[] = []
  try {
    const auth = await exec(gogBin(), ['auth', 'list', '--plain'])
    if (auth.ok) {
      for (const account of parseGogAccounts(auth.stdout, 'calendar')) {
        sources.push({
          id: account,
          provider: 'google',
          address: account.toLowerCase(),
          events: (from, to) => googleEvents(exec, account, from, to),
        })
      }
    }
  } catch {
    // no Google calendars this tick
  }
  let outlook: string[] = []
  try {
    outlook = deps.msAccounts?.() ?? []
  } catch {
    outlook = []
  }
  for (const account of outlook) {
    if (!deps.client) break
    try {
      const client = deps.client(account)
      let address = ''
      try {
        const me = (await client.get('/me?$select=mail,userPrincipalName')) as {
          mail?: string | null
          userPrincipalName?: string | null
        }
        address = (me?.mail || me?.userPrincipalName || '').trim().toLowerCase()
      } catch {
        address = ''
      }
      sources.push({
        id: account,
        provider: 'outlook',
        address,
        events: (from, to) => outlookEvents(client, account, address, from, to),
      })
    } catch {
      // this Outlook account is skipped this tick
    }
  }
  return sources
}

/**
 * Events from every source in [fromMs, toMs), soonest first, the same meeting
 * on two calendars kept once. A source that fails is counted, not thrown.
 */
export async function upcomingEvents(
  sources: CalendarSource[],
  fromMs: number,
  toMs: number
): Promise<{ events: UpcomingEvent[]; failures: number; ownAddresses: string[] }> {
  const seen = new Set<string>()
  const events: UpcomingEvent[] = []
  let failures = 0
  for (const s of sources) {
    let list: UpcomingEvent[]
    try {
      list = await s.events(fromMs, toMs)
    } catch {
      failures++
      continue
    }
    for (const e of list) {
      if (e.startMs < fromMs || e.startMs >= toMs) continue
      const key = `${e.seriesKey}|${e.startMs}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push(e)
    }
  }
  events.sort((a, b) => a.startMs - b.startMs)
  const ownAddresses = [...new Set(sources.map((s) => s.address).filter(Boolean))]
  // Another of the owner's own addresses invited to the same meeting is not an attendee.
  for (const e of events) e.attendees = e.attendees.filter((a) => !ownAddresses.includes(a.email))
  return { events, failures, ownAddresses }
}
