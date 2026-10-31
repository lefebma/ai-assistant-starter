import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-proactive-service-'))
process.env['AGENT_STORE_DIR'] = STORE

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../src/logger.js', () => ({ logger: log }))

type Svc = typeof import('../src/proactive/service.js')
type Store = typeof import('../src/proactive/store.js')
type Ctl = typeof import('../src/proactive/control.js')
type Settings = typeof import('../src/proactive/settings.js')
type Db = typeof import('../src/db.js')
type UpcomingEvent = import('../src/proactive/calendar.js').UpcomingEvent
type CalendarSource = import('../src/proactive/calendar.js').CalendarSource
type RelatedThread = import('../src/proactive/threads.js').RelatedThread
type DecideOutcome = import('../src/proactive/decide.js').DecideOutcome
type TickDeps = import('../src/proactive/service.js').TickDeps
let svc: Svc
let s: Store
let ctl: Ctl
let st: Settings
let dbm: Db

const TZ = 'America/Toronto'
const MIN = 60_000
const NOW = Date.parse('2026-10-30T17:35:00Z') // 13:35 Toronto
const START = Date.parse('2026-10-30T18:00:00Z') // 14:00, so a 30-minute briefing is due

beforeAll(async () => {
  dbm = await import('../src/db.js')
  dbm.initDatabase()
  s = await import('../src/proactive/store.js')
  svc = await import('../src/proactive/service.js')
  ctl = await import('../src/proactive/control.js')
  st = await import('../src/proactive/settings.js')
})

function briefings(on: boolean, leadMinutes = 30): void {
  st.saveSettings({ ...st.defaultSettings(), briefing: { on, leadMinutes } })
}

beforeEach(() => {
  const d = dbm.getDb()
  for (const t of ['proactive_decisions', 'proactive_covered', 'proactive_calls', 'proactive_trips', 'proactive_seen']) d.exec(`DELETE FROM ${t}`)
  briefings(true)
  st.applyChange(st.getSettings(), { quietHours: null }, [])
  log.info.mockClear()
  log.warn.mockClear()
})

function event(over: Partial<UpcomingEvent> = {}): UpcomingEvent {
  return {
    account: 'me@x.com',
    provider: 'google',
    id: 'e1',
    seriesKey: 'series-1',
    title: 'Southtel cutover',
    startMs: START,
    endMs: START + 60 * MIN,
    location: '',
    attendees: [{ email: 'devon@client.com', name: 'Devon Spencer' }],
    organizer: false,
    link: '',
    ...over,
  }
}

function thread(n: number, ids = [`m${n}`]): RelatedThread {
  return {
    ref: `t${n}`,
    subject: `Thread ${n}`,
    lastAt: START - n * 3_600_000,
    lastFromOwner: false,
    lastInbound: { from: 'Devon <devon@client.com>', at: START - n * 3_600_000, excerpt: 'Can you confirm?' },
    messages: 1,
    messageIds: ids,
    link: `https://mail.example/t${n}`,
  }
}

function brief(threads: RelatedThread[]): DecideOutcome {
  return {
    kind: 'decision',
    decision: {
      brief: true,
      reason: 'Devon is waiting on an answer',
      picks: threads.map((t) => ({ thread: t, why: 'Open question' })),
      owed: [],
    },
  }
}

function deps(opts: Partial<Omit<TickDeps, 'now'>> & { events?: UpcomingEvent[]; now?: number } = {}) {
  const { events, now, ...over } = opts
  const sent: string[] = []
  const source: CalendarSource = {
    id: 'me@x.com',
    provider: 'google',
    address: 'me@x.com',
    events: async () => events ?? [event()],
  }
  const d: TickDeps = {
    calendars: async () => [source],
    threads: vi.fn(async () => [thread(1)]),
    decide: vi.fn(async (_e: UpcomingEvent, t: RelatedThread[]) => brief(t)),
    send: vi.fn(async (text: string) => {
      sent.push(text)
      return { chatId: 'c', messageId: String(sent.length) }
    }),
    now: () => new Date(now ?? NOW),
    tz: TZ,
    format: 'plain',
    ...over,
  }
  return { d, sent }
}

describe('tick', () => {
  it('does nothing while off', async () => {
    briefings(false)
    const { d } = deps()
    await svc.tick(d)
    expect(d.threads).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('briefs a due meeting once, across ticks', async () => {
    const { d, sent } = deps()
    const r = await svc.tick(d)
    expect(r).toMatchObject({ sent: 1, decided: 1 })
    expect(sent[0]).toContain('Before Southtel cutover at 14:00 (Devon Spencer):')
    expect(sent[0]).toContain('1. Thread 1: Open question')
    await svc.tick(deps({ now: NOW + 10 * MIN }).d)
    expect(s.recentDecisions(10)).toHaveLength(1)
    expect(s.recentDecisions(10)[0]).toMatchObject({ status: 'sent', chatMessageId: '1' })
  })

  it('waits until the lead time, and skips a meeting about to start', async () => {
    const early = deps({ now: START - 45 * MIN })
    await svc.tick(early.d)
    expect(early.d.threads).not.toHaveBeenCalled()
    const late = deps({ now: START - 3 * MIN })
    await svc.tick(late.d)
    expect(late.d.threads).not.toHaveBeenCalled()
  })

  it('records why it stayed quiet: no attendees, no mail, or the model said no', async () => {
    const solo = deps({ events: [event({ attendees: [] })] })
    await svc.tick(solo.d)
    const nomail = deps({ events: [event({ id: 'e2' })], threads: vi.fn(async () => []) })
    await svc.tick(nomail.d)
    const no = deps({
      events: [event({ id: 'e3' })],
      decide: vi.fn(async () => ({ kind: 'decision', decision: { brief: false, reason: 'Routine', picks: [], owed: [] } }) as DecideOutcome),
    })
    await svc.tick(no.d)
    const reasons = s.recentDecisions(10).map((r) => [r.status, r.reason])
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['quiet', svc.QUIET_NO_ATTENDEES],
        ['quiet', svc.QUIET_NO_MAIL],
        ['quiet', 'Routine'],
      ])
    )
    expect(solo.d.send).not.toHaveBeenCalled()
    expect(nomail.d.decide).not.toHaveBeenCalled()
    expect(no.d.send).not.toHaveBeenCalled()
  })

  it('retries a failed send next tick, and gives up once the meeting is close', async () => {
    const failing = deps({ send: vi.fn(async () => null) })
    await svc.tick(failing.d)
    expect(s.recentDecisions(1)[0]!.status).toBe('pending')
    const retry = deps({ now: NOW + 10 * MIN })
    await svc.tick(retry.d)
    expect(retry.sent).toHaveLength(1)
    expect(retry.d.decide).not.toHaveBeenCalled()
    expect(s.recentDecisions(1)[0]!.status).toBe('sent')

    dbm.getDb().exec('DELETE FROM proactive_decisions')
    await svc.tick(deps({ send: vi.fn(async () => null) }).d)
    const tooLate = deps({ now: START - 2 * MIN })
    await svc.tick(tooLate.d)
    expect(tooLate.sent).toHaveLength(0)
    expect(s.recentDecisions(1)[0]!.status).toBe('failed')
  })

  it('decides a moved meeting again, without repeating what it already said', async () => {
    await svc.tick(deps().d)
    const moved = deps({ now: NOW + 30 * MIN, events: [event({ startMs: START + 30 * MIN })] })
    await svc.tick(moved.d)
    expect(moved.sent).toHaveLength(0)
    expect(s.recentDecisions(1)[0]).toMatchObject({ status: 'quiet', reason: svc.QUIET_NOTHING_NEW, startMs: START + 30 * MIN })
    const movedAgain = deps({
      now: NOW + 60 * MIN,
      events: [event({ startMs: START + 60 * MIN })],
      threads: vi.fn(async () => [thread(2)]),
    })
    await svc.tick(movedAgain.d)
    expect(movedAgain.sent).toHaveLength(1)
  })

  it('briefs a recurring meeting only on mail its last briefing did not cover', async () => {
    await svc.tick(deps().d)
    const next = deps({
      now: NOW + 7 * 86_400_000,
      events: [event({ id: 'e1-next', startMs: START + 7 * 86_400_000 })],
    })
    await svc.tick(next.d)
    expect(next.d.decide).not.toHaveBeenCalled()
    expect(s.recentDecisions(1)[0]).toMatchObject({ status: 'quiet', reason: svc.QUIET_NOTHING_NEW })

    const newer = deps({
      now: NOW + 14 * 86_400_000,
      events: [event({ id: 'e1-later', startMs: START + 14 * 86_400_000 })],
      threads: vi.fn(async () => [thread(1, ['m1', 'm9'])]),
    })
    await svc.tick(newer.d)
    expect(newer.sent).toHaveLength(1)
  })

  it('tries again next tick when the model or mailbox fails, and stops at the cap', async () => {
    const failed = deps({ decide: vi.fn(async () => ({ kind: 'failed' }) as DecideOutcome) })
    await svc.tick(failed.d)
    expect(s.recentDecisions(10)).toHaveLength(0)
    const broken = deps({ threads: vi.fn(async () => Promise.reject(new Error('down'))) })
    expect((await svc.tick(broken.d)).failures).toBe(1)
    expect(s.recentDecisions(10)).toHaveLength(0)

    const capped = deps({
      events: [event(), event({ id: 'e2' })],
      decide: vi.fn(async () => ({ kind: 'capped' }) as DecideOutcome),
    })
    await svc.tick(capped.d)
    expect(capped.d.decide).toHaveBeenCalledTimes(1)
  })

  it('never logs a title, an attendee or a subject', async () => {
    await svc.tick(deps().d)
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toMatch(/Southtel|Devon|Thread 1|devon@client/)
  })
})

describe('control', () => {
  const cdeps = (sources: CalendarSource[] = [{ id: 'me@x.com', provider: 'google', address: 'me@x.com', events: async () => [] }]) => ({
    calendars: async () => sources,
    now: () => new Date(NOW),
    tz: TZ,
  })

  it('will not turn on without a calendar, and says what it reads when it does', async () => {
    briefings(false)
    expect(await ctl.runControl(['on'], cdeps([]))).toContain('No calendar is connected')
    expect(st.getSettings().briefing.on).toBe(false)
    const reply = await ctl.runControl(['on'], cdeps())
    expect(reply).toContain('me@x.com (Google)')
    expect(reply).toContain('I never reply, send or change anything')
    expect(st.getSettings().briefing.on).toBe(true)
    expect(st.getSettings().travel.on).toBe(true)
    expect(st.getSettings().timing.on).toBe(true)
    expect(await ctl.runControl(['off'], cdeps())).toBe('Meeting briefings are off.\nTravel messages are off.\nTiming warnings are off.')
  })

  it('sets the lead time within bounds', async () => {
    expect(await ctl.runControl(['lead', '2'], cdeps())).toContain('from 5 to 180')
    expect(await ctl.runControl(['lead', '60'], cdeps())).toContain('60 minutes')
    expect(st.getSettings().briefing.leadMinutes).toBe(60)
  })

  it('shows the decision log in plain words', async () => {
    await svc.tick(deps().d)
    await svc.tick(deps({ events: [event({ id: 'e2', attendees: [] })] }).d)
    const out = await ctl.runControl(['log'], cdeps())
    expect(out).toContain('Southtel cutover: briefing sent (Devon is waiting on an answer)')
    expect(out).toContain(`Southtel cutover: no briefing: ${svc.QUIET_NO_ATTENDEES}`)
    expect(await ctl.runControl(['status'], cdeps())).toContain('1 briefing sent, 1 meeting with nothing worth a message')
  })
})

describe('settings (card #262)', () => {
  it('starts with every kind off', () => {
    const d = st.defaultSettings()
    expect([d.briefing.on, d.travel.on, d.timing.on]).toEqual([false, false, false])
    expect(st.anyOn(d)).toBe(false)
  })

  it('reads the 1.56.0 shape, keeping briefings on with their lead time', () => {
    expect(st.normalize({ enabled: true, leadMinutes: 45, windowHours: 24 }).briefing).toEqual({ on: true, leadMinutes: 45 })
    expect(st.normalize({ enabled: false }).briefing.on).toBe(false)
    expect(st.normalize('junk')).toEqual(st.defaultSettings())
    expect(st.normalize({ briefing: { on: true, leadMinutes: 999 } }).briefing.leadMinutes).toBe(30)
  })

  it('survives a save and reload', () => {
    briefings(true, 60)
    expect(st.getSettings().briefing).toEqual({ on: true, leadMinutes: 60 })
  })

  it('works out when quiet hours end, across midnight', () => {
    const q = { start: '22:00', end: '07:00' }
    const late = Date.parse('2026-10-30T03:30:00Z') // 23:30 Toronto
    expect(st.quietUntil(late, TZ, q)).toBe(Date.parse('2026-10-30T11:00:00Z')) // 07:00 next morning
    expect(st.quietUntil(NOW, TZ, q)).toBeNull()
    expect(st.quietUntil(late, TZ, null)).toBeNull()
  })

  it('refuses a kind that is not built yet, and turning on with no calendar', () => {
    briefings(false)
    const timing = st.KINDS.find((k) => k.id === 'timing')!
    timing.available = false
    try {
      expect(st.applyChange(st.getSettings(), { on: { timing: true } }, ['me@x.com (Google)'])).toMatchObject({
        ok: false,
        message: 'Timing warnings are not available yet.',
      })
    } finally {
      timing.available = true
    }
    const r = st.applyChange(st.getSettings(), { on: { briefing: true }, leadMinutes: 60 }, [])
    expect(r.ok).toBe(false)
    expect(st.getSettings().briefing).toEqual({ on: false, leadMinutes: 30 })
  })

  it('keeps one quiet-hours setting, shared with email alerts', async () => {
    const alerts = await import('../src/email-alerts/store.js')
    const r = st.applyChange(st.getSettings(), { quietHours: { start: '21:30', end: '6:45' } }, [])
    expect(r.message).toContain('Quiet hours are 21:30 to 06:45')
    expect(alerts.getSettings()).toMatchObject({ quietStart: '21:30', quietEnd: '06:45' })
    expect(st.applyChange(st.getSettings(), { quietHours: { start: '9', end: '09:00' } }, []).ok).toBe(false)
    st.applyChange(st.getSettings(), { quietHours: null }, [])
    expect(st.getQuietHours()).toBeNull()
    const a = alerts.getSettings()
    expect(a.quietStart).toBe(a.quietEnd)
  })
})

describe('quiet hours in the tick', () => {
  const quiet = (start: string, end: string) => st.applyChange(st.getSettings(), { quietHours: { start, end } }, [])

  it('holds a briefing until quiet hours end, then sends it', async () => {
    quiet('13:00', '13:40')
    const held = deps()
    await svc.tick(held.d)
    expect(held.d.threads).not.toHaveBeenCalled()
    expect(s.recentDecisions(10)).toHaveLength(0)
    const after = deps({ now: NOW + 10 * MIN })
    await svc.tick(after.d)
    expect(after.sent).toHaveLength(1)
  })

  it('drops a briefing whose meeting starts before quiet hours end, and says why', async () => {
    quiet('13:00', '14:30')
    const { d } = deps()
    await svc.tick(d)
    expect(d.threads).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
    expect(s.recentDecisions(1)[0]).toMatchObject({ status: 'quiet', reason: svc.QUIET_HOURS })
  })

  it('does not send a waiting briefing in quiet hours', async () => {
    await svc.tick(deps({ send: vi.fn(async () => null) }).d)
    expect(s.recentDecisions(1)[0]!.status).toBe('pending')
    quiet('13:40', '14:30')
    const retry = deps({ now: NOW + 10 * MIN })
    await svc.tick(retry.d)
    expect(retry.sent).toHaveLength(0)
    expect(s.recentDecisions(1)[0]).toMatchObject({ status: 'quiet', reason: svc.QUIET_HOURS })
  })

  it('does nothing with briefings off, whatever else is set', async () => {
    briefings(false)
    const { d } = deps()
    await svc.tick(d)
    expect(d.threads).not.toHaveBeenCalled()
  })
})

describe('control (card #262)', () => {
  const cdeps = () => ({
    calendars: async () => [{ id: 'me@x.com', provider: 'google' as const, address: 'me@x.com', events: async () => [] }],
    now: () => new Date(NOW),
    tz: TZ,
  })

  it('turns one kind on or off', async () => {
    briefings(false)
    expect(await ctl.runControl(['on', 'timing'], cdeps())).toContain('Timing warnings are on. I check the next 24 hours')
    expect(await ctl.runControl(['off', 'warnings'], cdeps())).toBe('Timing warnings are off.')
    expect(await ctl.runControl(['on', 'briefings'], cdeps())).toContain('Meeting briefings are on.')
    expect(await ctl.runControl(['on', 'briefing'], cdeps())).toBe('Meeting briefings are already on.')
    expect(await ctl.runControl(['off', 'nonsense'], cdeps())).toContain('I don\'t know "nonsense"')
    expect(await ctl.runControl(['off'], cdeps())).toBe('Meeting briefings are off.')
  })

  it('sets and clears quiet hours, and shows them in status', async () => {
    expect(await ctl.runControl(['quiet', '22:00', '07:00'], cdeps())).toContain('Quiet hours are 22:00 to 07:00')
    expect(await ctl.runControl(['status'], cdeps())).toContain('Quiet hours are 22:00 to 07:00')
    expect(await ctl.runControl(['quiet', '22:00'], cdeps())).toContain('need a start and an end')
    expect(await ctl.runControl(['quiet', 'off'], cdeps())).toBe('Quiet hours are off.')
  })
})

describe('web settings body', () => {
  it('takes only known fields of the right type', async () => {
    const { parseChange } = await import('../src/web/proactive-routes.js')
    expect(parseChange({ on: { briefing: true }, leadMinutes: 45, quietHours: { start: '22:00', end: '07:00' } })).toEqual({
      on: { briefing: true },
      leadMinutes: 45,
      quietHours: { start: '22:00', end: '07:00' },
    })
    expect(parseChange({ quietHours: null })).toEqual({ quietHours: null })
    expect(parseChange({ on: { email: true } })).toBeNull()
    expect(parseChange({ on: { briefing: 'yes' } })).toBeNull()
    expect(parseChange({ leadMinutes: '45' })).toBeNull()
    expect(parseChange({ quietHours: '22-7' })).toBeNull()
    expect(parseChange([])).toBeNull()
    expect(parseChange({ bufferMinutes: 20, mode: 'walk', origin: '1 Home Rd' })).toEqual({ bufferMinutes: 20, mode: 'walk', origin: '1 Home Rd' })
    expect(parseChange({ bufferMinutes: '20' })).toBeNull()
    expect(parseChange({ origin: 5 })).toBeNull()
  })
})

describe('travel messages (card #260)', () => {
  type MapsClient = import('../src/maps/client.js').MapsClient
  const PLACE = '100 King St W, Toronto'
  const HOME = '1 Home Rd, Toronto'

  function travel(over: Partial<import('../src/proactive/settings.js').ProactiveSettings['travel']> = {}): void {
    st.saveSettings({
      ...st.defaultSettings(),
      travel: { on: true, bufferMinutes: 15, mode: 'drive', origin: HOME, ...over },
    })
  }

  function maps(minutes: number | null, mode: MapsClient['mode'] = 'proxy'): MapsClient {
    return {
      mode,
      attribution: mode === 'off' ? null : 'Travel data from Google Maps',
      geocode: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
      route: vi.fn(async () =>
        minutes === null
          ? { ok: false as const, reason: 'upstream' as const }
          : { ok: true as const, value: { mode: 'DRIVE' as const, durationSeconds: minutes * 60, distanceMeters: 5000 } }
      ),
      placeSearch: vi.fn(async () => ({ ok: true as const, value: [] })),
      usage: vi.fn(async () => ({ ok: false as const, reason: 'not_configured' as const })),
    }
  }

  const inPerson = (over: Partial<UpcomingEvent> = {}) => event({ location: PLACE, ...over })

  beforeEach(() => travel())

  it('sends the place, travel time and leave-by, a buffer before leave-by', async () => {
    const m = maps(20) // leave by 13:40, message due 13:25; it is 13:35
    const { d, sent } = deps({ events: [inPerson()], maps: () => m })
    await svc.tick(d)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(`Southtel cutover at 14:00, in person: ${PLACE}`)
    expect(sent[0]).toContain('Leave by 13:40. About 20 min by car from your starting address.')
    expect(sent[0]).toContain('Travel data from Google Maps')
    expect(m.route).toHaveBeenCalledTimes(1)
    expect(m.route).toHaveBeenCalledWith(expect.objectContaining({ origin: HOME, destination: PLACE, mode: 'DRIVE' }))
    expect(s.recentDecisions(1)[0]).toMatchObject({ kind: 'travel', status: 'sent' })
    expect(d.decide).not.toHaveBeenCalled()
  })

  it('plans the trip early, looks it up once more for traffic, and waits for its time', async () => {
    const m = maps(5) // leave by 13:55, message due 13:40
    const first = deps({ events: [inPerson()], maps: () => m })
    await svc.tick(first.d)
    expect(first.sent).toHaveLength(0)
    expect(m.route).toHaveBeenCalledTimes(1)
    const due = deps({ events: [inPerson()], maps: () => m, now: NOW + 5 * MIN })
    await svc.tick(due.d)
    expect(m.route).toHaveBeenCalledTimes(2)
    expect(due.sent).toHaveLength(1)
    await svc.tick(deps({ events: [inPerson()], maps: () => m, now: NOW + 10 * MIN }).d)
    expect(m.route).toHaveBeenCalledTimes(2)
  })

  it('leaves video calls and blank locations alone', async () => {
    const m = maps(20)
    const { d, sent } = deps({
      events: [event({ location: 'https://zoom.us/j/123' }), event({ id: 'e2', location: '' }), event({ id: 'e3', location: 'Microsoft Teams Meeting' })],
      maps: () => m,
    })
    await svc.tick(d)
    expect(sent.filter((t) => t.includes('in person'))).toHaveLength(0)
    expect(m.route).not.toHaveBeenCalled()
  })

  it('without maps, gives the place an hour ahead and never guesses a time', async () => {
    const m = maps(20, 'off')
    const { d, sent } = deps({ events: [inPerson()], maps: () => m })
    await svc.tick(d)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Travel time not available.')
    expect(sent[0]).not.toMatch(/Leave by|min by/)
    expect(sent[0]).not.toContain('Google')
    expect(m.route).not.toHaveBeenCalled()
  })

  it('says so when the route lookup fails, and asks for a starting address when none is set', async () => {
    const failed = deps({ events: [inPerson()], maps: () => maps(null) })
    await svc.tick(failed.d)
    expect(failed.sent[0]).toContain('Travel time not available.')
    dbm.getDb().exec('DELETE FROM proactive_decisions; DELETE FROM proactive_trips')
    travel({ origin: '' })
    const none = deps({ events: [inPerson()], maps: () => maps(20) })
    await svc.tick(none.d)
    expect(none.sent[0]).toContain('set a starting address')
  })

  it('starts the trip at the previous in-person meeting, leaving when it ends', async () => {
    const m = maps(20)
    const prev = event({ id: 'e0', title: 'Site walk', location: '50 Bay St, Toronto', startMs: START - 90 * MIN, endMs: START - 20 * MIN })
    const { d, sent } = deps({ events: [prev, inPerson()], maps: () => m })
    await svc.tick(d)
    expect(m.route).toHaveBeenCalledWith(
      expect.objectContaining({ origin: '50 Bay St, Toronto', departAt: new Date(START - 20 * MIN).toISOString() })
    )
    expect(sent[0]).toContain('from Site walk')
  })

  it('adds arrival notes from mail, and still sends when they fail', async () => {
    const notes = vi.fn(async () => ({ kind: 'notes' as const, notes: ['Park in the P2 visitor lot'] }))
    const { d, sent } = deps({ events: [inPerson()], maps: () => maps(20), notes })
    await svc.tick(d)
    expect(sent[0]).toContain('Before you go:\n- Park in the P2 visitor lot')
    dbm.getDb().exec('DELETE FROM proactive_decisions; DELETE FROM proactive_trips')
    const broken = deps({ events: [inPerson()], maps: () => maps(20), notes: vi.fn(async () => ({ kind: 'failed' as const })) })
    await svc.tick(broken.d)
    expect(broken.sent).toHaveLength(1)
    expect(broken.sent[0]).not.toContain('Before you go')
  })

  it('holds a travel message in quiet hours and drops it when the meeting starts first', async () => {
    st.applyChange(st.getSettings(), { quietHours: { start: '13:00', end: '14:30' } }, [])
    const { d, sent } = deps({ events: [inPerson()], maps: () => maps(20) })
    await svc.tick(d)
    expect(sent).toHaveLength(0)
    expect(s.recentDecisions(1)[0]).toMatchObject({ kind: 'travel', status: 'quiet', reason: svc.QUIET_HOURS })
  })

  it('sends a briefing and a travel message for the same meeting when both are on', async () => {
    st.saveSettings({ ...st.getSettings(), briefing: { on: true, leadMinutes: 30 } })
    const { d, sent } = deps({ events: [inPerson()], maps: () => maps(20) })
    await svc.tick(d)
    expect(sent).toHaveLength(2)
    expect(s.recentDecisions(5).map((r) => r.kind).sort()).toEqual(['briefing', 'travel'])
  })

  it('chat commands set the buffer, the mode and the starting address', async () => {
    const c = { calendars: async () => [], now: () => new Date(NOW), tz: TZ, mapsReady: () => true }
    expect(await ctl.runControl(['buffer', '20'], c)).toBe('Travel messages now arrive about 20 minutes before you need to leave.')
    expect(await ctl.runControl(['buffer', '90'], c)).toBe('Give the buffer in minutes, from 0 to 60.')
    expect(await ctl.runControl(['mode', 'transit'], c)).toBe('Travel times are now worked out for transit.')
    expect(await ctl.runControl(['mode', 'boat'], c)).toBe('Travel can be by drive, transit or walk.')
    expect(await ctl.runControl(['from', '200', 'Bay', 'St,', 'Toronto'], c)).toContain('Starting address saved: 200 Bay St, Toronto.')
    expect(st.getSettings().travel).toMatchObject({ bufferMinutes: 20, mode: 'transit', origin: '200 Bay St, Toronto' })
    expect(await ctl.runControl(['status'], c)).toContain('about 20 minutes before you need to leave, with travel times for transit from 200 Bay St, Toronto.')
    expect(await ctl.runControl(['from', 'off'], c)).toContain('Starting address cleared.')
  })

  it('says travel messages give the place only when no maps source is set up', () => {
    st.saveSettings(st.defaultSettings())
    const r = st.applyChange(st.getSettings(), { on: { travel: true } }, { calendars: ['me@x.com (Google)'], mapsReady: false })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('give the place only')
  })
})

describe('timing warnings (card #261)', () => {
  type MapsClient = import('../src/maps/client.js').MapsClient
  const HOUR = 60 * MIN
  const A = '100 King St W, Toronto'
  const B = '1 Yonge St, Toronto'

  function timing(over: Partial<import('../src/proactive/settings.js').ProactiveSettings> = {}): void {
    st.saveSettings({ ...st.defaultSettings(), timing: { on: true, aheadHours: 24 }, ...over })
  }

  function maps(minutes: number | null): MapsClient {
    return {
      mode: 'proxy',
      attribution: 'Travel data from Google Maps',
      geocode: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
      route: vi.fn(async () =>
        minutes === null
          ? { ok: false as const, reason: 'upstream' as const }
          : { ok: true as const, value: { mode: 'DRIVE' as const, durationSeconds: minutes * 60, distanceMeters: 5000 } }
      ),
      placeSearch: vi.fn(async () => ({ ok: true as const, value: [] })),
      usage: vi.fn(async () => ({ ok: false as const, reason: 'not_configured' as const })),
    }
  }
  const noMaps = (): MapsClient => ({ ...maps(null), mode: 'off', attribution: null })

  // 18:00 to 19:00 and 18:30 to 19:30 Toronto, well ahead of NOW (13:35).
  const LATER = START + 4 * HOUR
  const first = (over: Partial<UpcomingEvent> = {}) => event({ id: 'a', title: 'Silverts demo', startMs: LATER, endMs: LATER + HOUR, ...over })
  const second = (over: Partial<UpcomingEvent> = {}) =>
    event({ id: 'b', seriesKey: 'series-2', title: 'Dojo board', startMs: LATER + 30 * MIN, endMs: LATER + 90 * MIN, ...over })

  beforeEach(() => timing())

  it('reports an overlap once, in one or two lines, and again only when it changes', async () => {
    const { d, sent } = deps({ events: [first(), second()], maps: noMaps })
    await svc.tick(d)
    expect(sent).toEqual(['Calendar check: Silverts demo (18:00 to 19:00) overlaps Dojo board (18:30 to 19:30).'])
    await svc.tick(deps({ events: [first(), second()], maps: noMaps, now: NOW + 10 * MIN }).d)
    expect(s.recentDecisions(10).filter((r) => r.kind === 'timing')).toHaveLength(1)
    const moved = deps({ events: [first(), second({ startMs: LATER + 45 * MIN })], maps: noMaps, now: NOW + 20 * MIN })
    await svc.tick(moved.d)
    expect(moved.sent).toHaveLength(1)
    expect(moved.sent[0]).toContain('overlaps Dojo board (18:45 to 19:30)')
  })

  it('leaves free time, back-to-back meetings at one place and declined meetings alone', async () => {
    const { d, sent } = deps({ events: [first(), second({ free: true }), event({ id: 'c', startMs: LATER + HOUR, endMs: LATER + 2 * HOUR })], maps: noMaps })
    await svc.tick(d)
    expect(sent).toEqual([])
  })

  it('reminds once as the problem comes up, when the first report was well before', async () => {
    await svc.tick(deps({ events: [first(), second()], maps: noMaps }).d)
    const soon = LATER + 30 * MIN - 2 * HOUR + MIN
    const r = deps({ events: [first(), second()], maps: noMaps, now: soon })
    await svc.tick(r.d)
    expect(r.sent).toEqual(['Calendar check: Starting soon, still a problem: Silverts demo (18:00 to 19:00) overlaps Dojo board (18:30 to 19:30).'])
    const again = deps({ events: [first(), second()], maps: noMaps, now: soon + 10 * MIN })
    await svc.tick(again.d)
    expect(again.sent).toEqual([])
  })

  it('does not remind when the first report was already close', async () => {
    const close = LATER + 30 * MIN - HOUR
    await svc.tick(deps({ events: [first(), second()], maps: noMaps, now: close }).d)
    const r = deps({ events: [first(), second()], maps: noMaps, now: close + 10 * MIN })
    await svc.tick(r.d)
    expect(r.sent).toEqual([])
  })

  it('warns when the trip between two places is longer than the gap, looking it up once', async () => {
    const m = maps(35)
    const evs = () => [first({ location: A }), event({ id: 'b', title: 'Dojo board', location: B, startMs: LATER + 75 * MIN, endMs: LATER + 2 * HOUR })]
    const { d, sent } = deps({ events: evs(), maps: () => m })
    await svc.tick(d)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Silverts demo ends at 19:00 and Dojo board starts 15 min later, but the trip takes about 35 min by car.')
    expect(sent[0]).toContain(`From ${A} to ${B}.`)
    expect(sent[0]).toContain('Travel data from Google Maps')
    expect(m.route).toHaveBeenCalledWith(expect.objectContaining({ origin: A, destination: B }))
    await svc.tick(deps({ events: evs(), maps: () => m, now: NOW + 10 * MIN }).d)
    expect(m.route).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the trip fits the gap', async () => {
    const m = maps(10)
    const { d, sent } = deps({
      events: [first({ location: A }), event({ id: 'b', location: B, startMs: LATER + 75 * MIN, endMs: LATER + 2 * HOUR })],
      maps: () => m,
    })
    await svc.tick(d)
    expect(sent).toEqual([])
  })

  it('without a travel time, flags only two addresses with no gap', async () => {
    const noGap = deps({ events: [first({ location: A }), event({ id: 'b', title: 'Dojo board', location: B, startMs: LATER + HOUR, endMs: LATER + 2 * HOUR })], maps: noMaps })
    await svc.tick(noGap.d)
    expect(noGap.sent).toEqual([`Calendar check: Silverts demo ends at 19:00 and Dojo board starts with no gap, at a different address.\nFrom ${A} to ${B}.`])
    dbm.getDb().exec('DELETE FROM proactive_decisions')
    const gap = deps({ events: [first({ location: A }), event({ id: 'b', location: B, startMs: LATER + 75 * MIN, endMs: LATER + 2 * HOUR })], maps: noMaps })
    await svc.tick(gap.d)
    expect(gap.sent).toEqual([])
  })

  it('points out a meeting that moved since its last message, and not one never messaged', async () => {
    st.saveSettings({ ...st.defaultSettings(), briefing: { on: true, leadMinutes: 30 }, timing: { on: true, aheadHours: 24 } })
    const b1 = deps({ events: [event()], maps: noMaps })
    await svc.tick(b1.d)
    expect(b1.sent[0]).toContain('Before Southtel cutover at 14:00')
    const later = deps({ events: [event({ startMs: START + HOUR, endMs: START + 2 * HOUR }), first()], maps: noMaps, now: NOW + 10 * MIN })
    await svc.tick(later.d)
    expect(later.sent).toEqual(['Calendar check: Southtel cutover moved to 15:00 (was 14:00).'])
    const place = deps({ events: [event({ startMs: START + HOUR, endMs: START + 2 * HOUR, location: A })], maps: noMaps, now: NOW + 20 * MIN })
    await svc.tick(place.d)
    expect(place.sent).toEqual([`Calendar check: Southtel cutover at 15:00 is now at ${A} (was no place set).`])
  })

  it('puts every problem from one pass in one message', async () => {
    const { d, sent } = deps({
      events: [first(), second(), event({ id: 'c', seriesKey: 's-c', title: 'Gus call', startMs: LATER + 3 * HOUR, endMs: LATER + 4 * HOUR }), event({ id: 'd', seriesKey: 's-d', title: 'Leif check-in', startMs: LATER + 3 * HOUR, endMs: LATER + 4 * HOUR })],
      maps: noMaps,
    })
    await svc.tick(d)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.split('\n')).toEqual([
      'Calendar check:',
      '- Silverts demo (18:00 to 19:00) overlaps Dojo board (18:30 to 19:30).',
      '- Gus call (21:00 to 22:00) overlaps Leif check-in (21:00 to 22:00).',
    ])
  })

  it('retries a failed send with the others still waiting', async () => {
    const failing = deps({ events: [first(), second()], maps: noMaps, send: vi.fn(async () => null) })
    await svc.tick(failing.d)
    expect(s.recentDecisions(5)[0]).toMatchObject({ kind: 'timing', status: 'pending' })
    const ok = deps({ events: [first(), second()], maps: noMaps, now: NOW + 10 * MIN })
    await svc.tick(ok.d)
    expect(ok.sent).toHaveLength(1)
    expect(s.recentDecisions(5)[0]).toMatchObject({ kind: 'timing', status: 'sent' })
  })

  it('holds a warning in quiet hours, and drops one that starts first', async () => {
    st.applyChange(st.getSettings(), { quietHours: { start: '13:00', end: '18:30' } }, [])
    const { d, sent } = deps({ events: [first(), second(), event({ id: 'c', seriesKey: 's-c', title: 'Late', startMs: LATER + 4 * HOUR, endMs: LATER + 5 * HOUR }), event({ id: 'd', seriesKey: 's-d', title: 'Later', startMs: LATER + 4 * HOUR, endMs: LATER + 5 * HOUR })], maps: noMaps })
    await svc.tick(d)
    expect(sent).toEqual([])
    const rows = s.recentDecisions(5).filter((r) => r.kind === 'timing')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'quiet', reason: svc.QUIET_HOURS })
  })

  it('never logs a title or a place', async () => {
    await svc.tick(deps({ events: [first({ location: A }), second({ location: B })], maps: () => maps(30) }).d)
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
    for (const word of ['Silverts', 'Dojo', 'King St', 'Yonge']) expect(logged).not.toContain(word)
  })

  it('chat and the web set how far ahead to look, within bounds', async () => {
    const cd = { calendars: async () => [], now: () => new Date(NOW), tz: TZ }
    expect(await ctl.runControl(['ahead', '48'], cd)).toBe('Timing warnings now look 48 hours ahead.')
    expect(await ctl.runControl(['ahead', '48'], cd)).toBe('Timing warnings already look 48 hours ahead.')
    expect(await ctl.runControl(['ahead', '100'], cd)).toBe('Give how far ahead to look in hours, from 1 to 72.')
    expect(await ctl.runControl(['status'], cd)).toContain('Timing warnings are on, looking 48 hours ahead.')
    const { parseChange } = await import('../src/web/proactive-routes.js')
    expect(parseChange({ aheadHours: 12 })).toEqual({ aheadHours: 12 })
    expect(parseChange({ aheadHours: '12' })).toBeNull()
  })

  it('reads far enough ahead for the setting', async () => {
    timing({ timing: { on: true, aheadHours: 48 } })
    const calls: [number, number][] = []
    const { d } = deps({ maps: noMaps })
    d.calendars = async () => [{ id: 'me@x.com', provider: 'google', address: 'me@x.com', events: async (f, t) => (calls.push([f, t]), []) }]
    await svc.tick(d)
    expect(calls[0]![1] - NOW).toBe(48 * HOUR)
    expect(NOW - calls[0]![0]).toBe(8 * HOUR)
  })
})
