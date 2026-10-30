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
  for (const t of ['proactive_decisions', 'proactive_covered', 'proactive_calls']) d.exec(`DELETE FROM ${t}`)
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
    expect(await ctl.runControl(['off'], cdeps())).toBe('Meeting briefings are off.')
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
    expect(out).toContain(`Southtel cutover: no message: ${svc.QUIET_NO_ATTENDEES}`)
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
    expect(st.applyChange(st.getSettings(), { on: { travel: true } }, ['me@x.com (Google)'])).toMatchObject({
      ok: false,
      message: 'Travel messages are not available yet.',
    })
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

  it('turns one kind on or off, and refuses kinds not built yet', async () => {
    briefings(false)
    expect(await ctl.runControl(['on', 'travel'], cdeps())).toBe('Travel messages are not available yet.')
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
  })
})
