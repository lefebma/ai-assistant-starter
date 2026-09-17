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
    await eventsInRange(f.client, '2026-09-16', '2026-09-17', 'America/Toronto')
    expect(f.calls[0]!.path).toContain('/me/calendarView')
    expect(f.calls[0]!.path).toContain('startDateTime=2026-09-16')
  })

  it('maps events into something readable', async () => {
    const out = await eventsInRange(fake([{ value: [EVT] }]).client, '2026-09-16', '2026-09-17', 'UTC')
    expect(out[0]).toMatchObject({ id: 'E1', subject: 'Standup', location: 'Teams', allDay: false })
  })

  it('handles an event with no location', async () => {
    const out = await eventsInRange(fake([{ value: [{ ...EVT, location: undefined }] }]).client, 'a', 'b', 'UTC')
    expect(out[0]!.location).toBe('')
  })

  it('returns nothing for an empty calendar rather than throwing', async () => {
    expect(await eventsInRange(fake([{}]).client, 'a', 'b', 'UTC')).toEqual([])
  })
})

describe('eventsToday', () => {
  it('asks for the single day that today is in the owner timezone', async () => {
    const f = fake([{ value: [] }])
    await eventsToday(f.client, 'America/Toronto', new Date('2026-09-16T03:30:00Z'))
    // 03:30 UTC is still the 15th in Toronto; asking for the 16th would show
    // the owner tomorrow's calendar and call it today.
    expect(f.calls[0]!.path).toContain('startDateTime=2026-09-15')
    expect(f.calls[0]!.path).toContain('endDateTime=2026-09-16')
  })
})

describe('createEvent', () => {
  it('posts the event with its timezone', async () => {
    const f = fake([{ id: 'E9' }])
    const out = await createEvent(f.client, {
      subject: 'Review',
      start: '2026-09-20T10:00',
      end: '2026-09-20T11:00',
      timeZone: 'America/Toronto',
    })
    expect(out.id).toBe('E9')
    const body = f.calls[0]!.body as { start: { timeZone: string }; subject: string }
    expect(body.start.timeZone).toBe('America/Toronto')
    expect(body.subject).toBe('Review')
  })

  it('adds attendees when given', async () => {
    const f = fake([{ id: 'E9' }])
    await createEvent(f.client, { subject: 'S', start: 'a', end: 'b', timeZone: 'UTC', attendees: ['x@y.com'] })
    const body = f.calls[0]!.body as { attendees: { emailAddress: { address: string } }[] }
    expect(body.attendees[0]!.emailAddress.address).toBe('x@y.com')
  })

  it('refuses an event that ends before it starts', async () => {
    await expect(
      createEvent(fake().client, { subject: 'S', start: '2026-09-20T11:00', end: '2026-09-20T10:00', timeZone: 'UTC' })
    ).rejects.toThrow(/end/i)
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

  it('marks an all-day event as such instead of showing 00:00', () => {
    const out = renderEvents([
      { id: 'E2', subject: 'Holiday', start: '2026-09-16T00:00:00', end: '2026-09-17T00:00:00', location: '', allDay: true },
    ])
    expect(out).toMatch(/all day/i)
    expect(out).not.toContain('00:00')
  })
})
