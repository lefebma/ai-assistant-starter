import { describe, it, expect } from 'vitest'
import { eventsToday, eventsInRange, createEvent, renderEvents } from '../src/ms/calendar.js'

function fake(responses: unknown[] = []) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const q = [...responses]
  return {
    calls,
    client: {
      get: async (path: string) => { calls.push({ method: 'GET', path }); return q.shift() ?? {} },
      post: async (path: string, body: unknown) => { calls.push({ method: 'POST', path, body }); return q.shift() ?? {} },
      patch: async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return q.shift() ?? {} },
    } as never,
  }
}

const EVT = {
  id: 'E1',
  subject: 'Standup',
  start: { dateTime: '2026-09-16T09:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-16T09:15:00.0000000', timeZone: 'UTC' },
  location: { displayName: 'Teams' },
  isAllDay: false,
}

describe('eventsInRange', () => {
  it('uses calendarView, which is the endpoint that expands recurrences', async () => {
    // /me/events returns the recurring master, not its occurrences, so a
    // weekly standup shows once a year instead of once a week.
    const f = fake([{ value: [EVT] }])
    await eventsInRange(f.client, '2026-09-16', '2026-09-16', 'America/Toronto')
    expect(f.calls[0]!.path).toContain('/me/calendarView')
  })

  it("sends local midnights with their offset, since a bare date is read as UTC", async () => {
    const f = fake([{ value: [] }])
    await eventsInRange(f.client, '2026-09-16', '2026-09-16', 'America/Toronto')
    const path = decodeURIComponent(f.calls[0]!.path)
    expect(path).toContain('startDateTime=2026-09-16T00:00:00-04:00')
    expect(path).toContain('endDateTime=2026-09-17T00:00:00-04:00')
  })

  it('treats the last day as included', async () => {
    const f = fake([{ value: [] }])
    await eventsInRange(f.client, '2026-09-14', '2026-09-18', 'UTC')
    expect(decodeURIComponent(f.calls[0]!.path)).toContain('endDateTime=2026-09-19T00:00:00+00:00')
  })

  it('refuses something that is not a date, before calling Graph', async () => {
    const f = fake()
    await expect(eventsInRange(f.client, 'tomorrow', '2026-09-18', 'UTC')).rejects.toThrow(/2026-09-20/)
    await expect(eventsInRange(f.client, '2026-02-30', '2026-03-01', 'UTC')).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })

  it('refuses a range that ends before it starts', async () => {
    await expect(eventsInRange(fake().client, '2026-09-18', '2026-09-14', 'UTC')).rejects.toThrow(/before/)
  })

  it("converts Graph's UTC times to the owner's wall clock", async () => {
    const out = await eventsInRange(fake([{ value: [EVT] }]).client, '2026-09-16', '2026-09-16', 'America/Toronto')
    expect(out[0]).toMatchObject({ id: 'E1', subject: 'Standup', location: 'Teams', allDay: false })
    expect(out[0]!.start).toBe('2026-09-16T05:00:00')
    expect(out[0]!.end).toBe('2026-09-16T05:15:00')
  })

  it('leaves an all-day event on its own date instead of moving it to the evening before', async () => {
    const holiday = {
      ...EVT,
      isAllDay: true,
      start: { dateTime: '2026-09-16T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-09-17T00:00:00.0000000', timeZone: 'UTC' },
    }
    const out = await eventsInRange(fake([{ value: [holiday] }]).client, '2026-09-16', '2026-09-16', 'America/Toronto')
    expect(out[0]!.start).toBe('2026-09-16T00:00:00')
  })

  it('handles an event with no location', async () => {
    const f = fake([{ value: [{ ...EVT, location: undefined }] }])
    const out = await eventsInRange(f.client, '2026-09-16', '2026-09-16', 'UTC')
    expect(out[0]!.location).toBe('')
  })

  it('returns nothing for an empty calendar rather than throwing', async () => {
    expect(await eventsInRange(fake([{}]).client, '2026-09-16', '2026-09-16', 'UTC')).toEqual([])
  })
})

describe('eventsToday', () => {
  it('asks for the single day that today is in the owner timezone', async () => {
    const f = fake([{ value: [] }])
    await eventsToday(f.client, 'America/Toronto', new Date('2026-09-16T03:30:00Z'))
    // 03:30 UTC is still the 15th in Toronto; asking for the 16th would show
    // the owner tomorrow's calendar and call it today.
    const path = decodeURIComponent(f.calls[0]!.path)
    expect(path).toContain('startDateTime=2026-09-15T00:00:00-04:00')
    expect(path).toContain('endDateTime=2026-09-16T00:00:00-04:00')
  })
})

describe('createEvent', () => {
  const BASE = { subject: 'Review', start: '2026-09-20T10:00', end: '2026-09-20T11:00', timeZone: 'America/Toronto' }

  it('posts the event with its timezone', async () => {
    const f = fake([{ id: 'E9' }])
    const out = await createEvent(f.client, BASE)
    expect(out.id).toBe('E9')
    const body = f.calls[0]!.body as { start: { timeZone: string }; subject: string }
    expect(body.start.timeZone).toBe('America/Toronto')
    expect(body.subject).toBe('Review')
  })

  it('will not invite anyone without approval, because the invitation goes out on create', async () => {
    const f = fake([{ id: 'E9' }])
    await expect(createEvent(f.client, { ...BASE, attendees: ['x@y.com'] })).rejects.toThrow(/approv/i)
    expect(f.calls).toHaveLength(0)
  })

  it('adds attendees once approved', async () => {
    const f = fake([{ id: 'E9' }])
    await createEvent(f.client, { ...BASE, attendees: [' x@y.com ', ''], invitesApproved: true })
    const body = f.calls[0]!.body as { attendees: { emailAddress: { address: string } }[] }
    expect(body.attendees).toHaveLength(1)
    expect(body.attendees[0]!.emailAddress.address).toBe('x@y.com')
  })

  it('refuses an event that ends before it starts', async () => {
    await expect(createEvent(fake().client, { ...BASE, start: '2026-09-20T11:00', end: '2026-09-20T10:00' })).rejects.toThrow(
      /end/i
    )
  })

  it('refuses a time it cannot read rather than letting Graph guess', async () => {
    await expect(createEvent(fake().client, { ...BASE, start: 'tomorrow at 10' })).rejects.toThrow(/2026-09-20T10:00/)
  })
})

describe('renderEvents', () => {
  it('says the calendar is clear rather than printing nothing', () => {
    expect(renderEvents([])).toMatch(/nothing|clear|no events/i)
  })

  it('lists events with their times', () => {
    const out = renderEvents([
      { id: 'E1', subject: 'Standup', start: '2026-09-16T09:00:00', end: '2026-09-16T09:15:00', location: 'Teams', allDay: false },
    ])
    expect(out).toContain('Standup')
    expect(out).toContain('09:00')
  })

  it('adds a heading per day when the events span more than one', () => {
    const out = renderEvents([
      { id: 'E1', subject: 'Standup', start: '2026-09-16T09:00:00', end: '2026-09-16T09:15:00', location: '', allDay: false },
      { id: 'E2', subject: 'Review', start: '2026-09-17T14:00:00', end: '2026-09-17T15:00:00', location: '', allDay: false },
    ])
    expect(out.split('\n')).toEqual(['Wed 2026-09-16', '  09:00-09:15  Standup', 'Thu 2026-09-17', '  14:00-15:00  Review'])
  })

  it('dates a lone event when asked, so a week with one appointment says which day', () => {
    // Found live: a week-long range with a single event printed its time and
    // no date at all.
    const out = renderEvents(
      [{ id: 'E1', subject: 'Chiro', start: '2026-09-15T16:45:00', end: '2026-09-15T17:15:00', location: '', allDay: false }],
      true
    )
    expect(out.split('\n')).toEqual(['Tue 2026-09-15', '  16:45-17:15  Chiro'])
  })

  it('marks an all-day event as such instead of showing 00:00', () => {
    const out = renderEvents([
      { id: 'E2', subject: 'Holiday', start: '2026-09-16T00:00:00', end: '2026-09-17T00:00:00', location: '', allDay: true },
    ])
    expect(out).toMatch(/all day/i)
    expect(out).not.toContain('00:00')
  })
})
