import { describe, it, expect } from 'vitest'
import {
  discoverCalendars,
  parseGoogleEvents,
  parseOutlookEvents,
  upcomingEvents,
  type CalendarSource,
  type UpcomingEvent,
} from '../src/proactive/calendar.js'

const OWN = 'owner@example.com'

function gEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev1',
    iCalUID: 'uid1@google.com',
    status: 'confirmed',
    summary: 'Cutover review',
    location: '100 King St W, Toronto',
    htmlLink: 'https://calendar.google.com/event?eid=1',
    eventType: 'default',
    start: { dateTime: '2026-10-30T14:00:00-04:00' },
    end: { dateTime: '2026-10-30T15:00:00-04:00' },
    organizer: { email: 'devon@client.com' },
    attendees: [
      { email: OWN, self: true, responseStatus: 'accepted' },
      { email: 'Devon@Client.com', displayName: 'Devon Spencer', responseStatus: 'accepted' },
      { email: 'room-4b@resource.calendar.google.com', resource: true },
    ],
    ...over,
  }
}

describe('parseGoogleEvents', () => {
  it('keeps a timed meeting, without the owner or rooms in the attendees', () => {
    const [e] = parseGoogleEvents(JSON.stringify([gEvent()]), OWN)
    expect(e).toMatchObject({
      provider: 'google',
      account: OWN,
      title: 'Cutover review',
      location: '100 King St W, Toronto',
      organizer: false,
      seriesKey: 'uid1@google.com',
      attendees: [{ email: 'devon@client.com', name: 'Devon Spencer' }],
    })
    expect(e!.startMs).toBe(Date.parse('2026-10-30T18:00:00Z'))
  })

  it('drops declined, cancelled, all-day and non-meeting events', () => {
    const rows = [
      gEvent({ id: 'declined', attendees: [{ email: OWN, self: true, responseStatus: 'declined' }] }),
      gEvent({ id: 'cancelled', status: 'cancelled' }),
      gEvent({ id: 'allday', start: { date: '2026-10-30' }, end: { date: '2026-10-31' } }),
      gEvent({ id: 'focus', eventType: 'focusTime' }),
    ]
    expect(parseGoogleEvents(JSON.stringify(rows), OWN)).toEqual([])
  })

  it('keys every occurrence of a series by its recurring event id', () => {
    const [e] = parseGoogleEvents(JSON.stringify([gEvent({ id: 'ev1_20261030', recurringEventId: 'ev1' })]), OWN)
    expect(e!.seriesKey).toBe('ev1')
  })

  it('reads the envelope shape too', () => {
    expect(parseGoogleEvents(JSON.stringify({ events: [gEvent()] }), OWN)).toHaveLength(1)
  })
})

describe('parseOutlookEvents', () => {
  const base = {
    id: 'o1',
    iCalUId: 'ical-o1',
    subject: 'Southtel sync',
    isAllDay: false,
    isCancelled: false,
    isOrganizer: true,
    responseStatus: { response: 'organizer' },
    start: { dateTime: '2026-10-30T18:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-30T18:30:00.0000000', timeZone: 'UTC' },
    location: { displayName: 'Teams' },
    attendees: [
      { type: 'required', emailAddress: { name: 'Owner', address: 'Owner@Example.com' } },
      { type: 'required', emailAddress: { name: 'James Bradley', address: 'james@bdc.ca' } },
      { type: 'resource', emailAddress: { name: 'Room', address: 'room@example.com' } },
    ],
    webLink: 'https://outlook.office.com/x',
  }

  it('reads Graph UTC times and drops the owner and rooms', () => {
    const [e] = parseOutlookEvents([base], 'default', OWN)
    expect(e!.startMs).toBe(Date.parse('2026-10-30T18:00:00Z'))
    expect(e!.attendees).toEqual([{ email: 'james@bdc.ca', name: 'James Bradley' }])
    expect(e!.organizer).toBe(true)
    expect(e!.seriesKey).toBe('ical-o1')
  })

  it('drops declined, cancelled, all-day and out-of-office', () => {
    const rows = [
      { ...base, id: 'a', responseStatus: { response: 'declined' } },
      { ...base, id: 'b', isCancelled: true },
      { ...base, id: 'c', isAllDay: true },
      { ...base, id: 'd', showAs: 'oof' },
    ]
    expect(parseOutlookEvents(rows, 'default', OWN)).toEqual([])
  })
})

function ev(over: Partial<UpcomingEvent>): UpcomingEvent {
  return {
    account: 'a@x.com',
    provider: 'google',
    id: 'e',
    seriesKey: 's',
    title: 't',
    startMs: 1_000,
    endMs: 2_000,
    location: '',
    attendees: [],
    organizer: false,
    link: '',
    ...over,
  }
}

describe('upcomingEvents', () => {
  it('keeps the same meeting once across calendars, soonest first, and counts a failed source', async () => {
    const sources: CalendarSource[] = [
      {
        id: 'a@x.com',
        provider: 'google',
        address: 'a@x.com',
        events: async () => [ev({ id: '2', seriesKey: 'm2', startMs: 5_000 }), ev({ id: '1', seriesKey: 'm1', startMs: 3_000 })],
      },
      {
        id: 'b@x.com',
        provider: 'google',
        address: 'b@x.com',
        events: async () => [
          ev({ id: 'dup', seriesKey: 'm1', startMs: 3_000, account: 'b@x.com' }),
          ev({ id: 'past', seriesKey: 'm0', startMs: 500 }),
        ],
      },
      { id: 'broken', provider: 'outlook', address: '', events: async () => Promise.reject(new Error('x')) },
    ]
    const { events, failures, ownAddresses } = await upcomingEvents(sources, 1_000, 10_000)
    expect(events.map((e) => e.id)).toEqual(['1', '2'])
    expect(failures).toBe(1)
    expect(ownAddresses).toEqual(['a@x.com', 'b@x.com'])
  })

  it("does not count the owner's other address as an attendee", async () => {
    const sources: CalendarSource[] = [
      { id: 'a@x.com', provider: 'google', address: 'a@x.com', events: async () => [ev({ attendees: [{ email: 'b@x.com', name: '' }, { email: 'c@y.com', name: '' }] })] },
      { id: 'b@x.com', provider: 'google', address: 'b@x.com', events: async () => [] },
    ]
    const { events } = await upcomingEvents(sources, 0, 10_000)
    expect(events[0]!.attendees.map((a) => a.email)).toEqual(['c@y.com'])
  })
})

describe('discoverCalendars', () => {
  it('lists Google accounts with the calendar service, and Outlook accounts by their address', async () => {
    const calls: string[][] = []
    const exec = async (_bin: string, args: string[]) => {
      calls.push(args)
      return {
        ok: true,
        stdout: ['a@x.com\tdefault\tcalendar,gmail\t2026', 'mailonly@x.com\tdefault\tgmail\t2026'].join('\n'),
      }
    }
    const client = { get: async () => ({ mail: 'Me@Corp.com' }), post: async () => ({}), patch: async () => ({}) }
    const sources = await discoverCalendars({ exec, msAccounts: () => ['default'], client: () => client })
    expect(sources.map((s) => [s.id, s.provider, s.address])).toEqual([
      ['a@x.com', 'google', 'a@x.com'],
      ['default', 'outlook', 'me@corp.com'],
    ])
    expect(calls[0]).toEqual(['auth', 'list', '--plain'])
  })

  it('never throws when a side cannot list its accounts', async () => {
    const exec = async () => {
      throw new Error('no gog')
    }
    const sources = await discoverCalendars({
      exec,
      msAccounts: () => {
        throw new Error('no vault')
      },
    })
    expect(sources).toEqual([])
  })
})
