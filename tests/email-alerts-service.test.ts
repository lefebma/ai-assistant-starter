import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-email-service-'))
process.env['AGENT_STORE_DIR'] = STORE

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('../src/logger.js', () => ({ logger: log }))

type Svc = typeof import('../src/email-alerts/service.js')
type Fmt = typeof import('../src/email-alerts/format.js')
type Store = typeof import('../src/email-alerts/store.js')
type Db = typeof import('../src/db.js')
let svc: Svc
let fmt: Fmt
let s: Store
let dbm: Db

type Mailbox = import('../src/email-alerts/sources.js').Mailbox
type NewMail = import('../src/email-alerts/sources.js').NewMail
type TriageOutcome = import('../src/email-alerts/triage.js').TriageOutcome
type TickDeps = import('../src/email-alerts/service.js').TickDeps

const NOON = new Date('2026-10-18T12:00:00Z')
const NIGHT = new Date('2026-10-18T23:30:00Z')
const HOUR = 3_600_000

beforeAll(async () => {
  dbm = await import('../src/db.js')
  dbm.initDatabase()
  s = await import('../src/email-alerts/store.js')
  svc = await import('../src/email-alerts/service.js')
  fmt = await import('../src/email-alerts/format.js')
})

function settings(over: Partial<import('../src/email-alerts/store.js').AlertSettings> = {}): void {
  s.saveSettings({
    enabled: true,
    pauseUntil: null,
    pauseIndefinite: false,
    pauseStartedAt: null,
    quietStart: '22:00',
    quietEnd: '07:00',
    seededMailboxes: ['a@x.com', 'b@x.com'],
    pauseSummaryPending: false,
    ...over,
  })
}

beforeEach(() => {
  const d = dbm.getDb()
  for (const t of [
    'email_alert_seen',
    'email_alerts',
    'email_alert_lists',
    'email_alert_menus',
    'email_alert_triage_counts',
  ]) {
    d.exec(`DELETE FROM ${t}`)
  }
  settings()
  log.info.mockClear()
  log.warn.mockClear()
  log.error.mockClear()
})

let seq = 0
function mail(over: Partial<NewMail> & { from?: string } = {}): NewMail {
  seq++
  const { from, ...rest } = over
  return {
    mailbox: 'a@x.com',
    msgId: `m${seq}`,
    rfcMessageId: `<r${seq}@x.com>`,
    receivedAt: NOON.getTime() - seq * 1000,
    headers: { from: from ?? `Person ${seq} <p${seq}@client.com>` },
    subject: `Subject ${seq}`,
    ...rest,
  }
}

function box(id: string, mails: NewMail[] | (() => Promise<NewMail[]>)): Mailbox {
  return {
    id,
    provider: 'gmail',
    list: typeof mails === 'function' ? mails : async () => mails.map((m) => ({ ...m, mailbox: id })),
    body: async () => 'body text',
  }
}

const critical = (reason = 'Client site is down'): TriageOutcome => ({
  kind: 'verdict',
  verdict: { critical: true, reason },
})

function deps(
  boxes: Mailbox[],
  opts: { triage?: (i: unknown) => Promise<TriageOutcome>; now?: Date } = {}
): TickDeps & { sends: { text: string; buttons?: string[] }[]; triageSpy: ReturnType<typeof vi.fn> } {
  const sends: { text: string; buttons?: string[] }[] = []
  const triageSpy = vi.fn(opts.triage ?? (async () => critical()))
  let n = 0
  return {
    sends,
    triageSpy,
    boxes: async () => ({ boxes, broken: [] }),
    triage: triageSpy as unknown as TickDeps['triage'],
    send: async (text, buttons) => {
      sends.push({ text, buttons })
      n++
      return { chatId: 'chat1', messageId: String(n) }
    },
    now: () => opts.now ?? NOON,
    tz: 'UTC',
  }
}

describe('format', () => {
  it('alert is three plain lines', () => {
    const text = fmt.formatAlert({
      id: 1,
      mailbox: 'a@x.com',
      msgId: 'm',
      sender: 'Jane Doe <jane@x.com>',
      subject: 'Site down',
      reason: 'Client says site is down',
      vip: false,
      status: 'sent',
      createdAt: 0,
      sentAt: null,
      chatId: null,
      chatMessageId: null,
      feedback: null,
      actions: [],
      attempts: 0,
    })
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Jane Doe')
    expect(lines[0]).toContain('jane@x.com')
    expect(lines[1]).toContain('Site down')
    expect(lines[2]).toContain('Client says site is down')
  })
  it('overflow copy', () => {
    expect(fmt.formatOverflow(3)).toBe('…and 3 more critical emails in your inbox.')
  })
  it('buttons in order', () => {
    expect(fmt.ALERT_BUTTONS).toEqual(['Useful', 'Not urgent', 'Mute sender', 'Pause alerts'])
  })
})

describe('tick', () => {
  it('disabled is a no-op', async () => {
    settings({ enabled: false })
    const d = deps([box('a@x.com', [mail()])])
    expect(await svc.tick(d)).toEqual({ sent: 0, held: 0, paused: 0, triaged: 0 })
    expect(d.sends).toHaveLength(0)
  })

  it('first run seeds and sends nothing', async () => {
    settings({ seededMailboxes: [] })
    const m = mail()
    const d = deps([box('a@x.com', [m])])
    const r = await svc.tick(d)
    expect(r.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
    expect(d.triageSpy).not.toHaveBeenCalled()
    expect(s.getSettings().seededMailboxes).toContain('a@x.com')
    // Already seen, so the next tick does not alert either.
    const r2 = await svc.tick(d)
    expect(r2.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
  })

  it('vip alerts without triage', async () => {
    s.listAdd('vip', 'boss@client.com')
    const d = deps([box('a@x.com', [mail({ from: 'Boss <boss@client.com>' })])])
    const r = await svc.tick(d)
    expect(d.triageSpy).not.toHaveBeenCalled()
    expect(r.sent).toBe(1)
    expect(d.sends).toHaveLength(1)
    expect(d.sends[0]!.text).toContain('From a VIP')
    expect(d.sends[0]!.buttons).toEqual(fmt.ALERT_BUTTONS)
    const row = s.alertsByStatus('sent')[0]!
    expect(row.vip).toBe(true)
    expect(row.chatMessageId).toBe('1')
  })

  it('muted vip does not alert', async () => {
    s.listAdd('vip', 'boss@client.com')
    s.listAdd('mute', 'client.com')
    const d = deps([box('a@x.com', [mail({ from: 'Boss <boss@client.com>' })])])
    const r = await svc.tick(d)
    expect(r.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
    expect(d.triageSpy).not.toHaveBeenCalled()
  })

  it('automated mail never reaches triage', async () => {
    const d = deps([
      box('a@x.com', [
        mail({ from: 'Shop <noreply@shop.com>' }),
        mail({ headers: { from: 'News <x@news.com>', listUnsubscribe: '<mailto:u@news.com>' } }),
      ]),
    ])
    const r = await svc.tick(d)
    expect(d.triageSpy).not.toHaveBeenCalled()
    expect(r.sent).toBe(0)
  })

  it('non-critical verdict does not alert', async () => {
    const d = deps([box('a@x.com', [mail()])], {
      triage: async () => ({ kind: 'verdict', verdict: { critical: false, reason: 'FYI' } }),
    })
    const r = await svc.tick(d)
    expect(r).toEqual({ sent: 0, held: 0, paused: 0, triaged: 1 })
    expect(d.sends).toHaveLength(0)
  })

  it('capped triage sends nothing but vip still alerts', async () => {
    s.listAdd('vip', 'boss@client.com')
    const d = deps([box('a@x.com', [mail(), mail({ from: 'Boss <boss@client.com>' }), mail()])], {
      triage: async () => ({ kind: 'capped' }),
    })
    const r = await svc.tick(d)
    expect(r.sent).toBe(1)
    expect(d.sends).toHaveLength(1)
    expect(d.sends[0]!.text).toContain('From a VIP')
  })

  it('failed triage does not alert', async () => {
    const d = deps([box('a@x.com', [mail()])], { triage: async () => ({ kind: 'failed' }) })
    const r = await svc.tick(d)
    expect(r.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
  })

  it('quiet hours hold non-vip, vip goes through', async () => {
    s.listAdd('vip', 'boss@client.com')
    const d = deps([box('a@x.com', [mail(), mail({ from: 'Boss <boss@client.com>' })])], { now: NIGHT })
    const r = await svc.tick(d)
    expect(r.sent).toBe(1)
    expect(r.held).toBe(1)
    expect(d.sends).toHaveLength(1)
    expect(d.sends[0]!.text).toContain('From a VIP')
    expect(s.alertsByStatus('held')).toHaveLength(1)
  })

  it('quiet end flushes held with the offline header', async () => {
    const night = deps([box('a@x.com', [mail(), mail()])], { now: NIGHT })
    await svc.tick(night)
    expect(night.sends).toHaveLength(0)
    const morning = deps([box('a@x.com', [])], { now: new Date('2026-10-19T07:05:00Z') })
    await svc.tick(morning)
    expect(morning.sends[0]!.text).toBe('While you were offline: 2 critical emails.')
    expect(morning.sends).toHaveLength(3)
    expect(morning.sends[1]!.buttons).toEqual(fmt.ALERT_BUTTONS)
    expect(s.alertsByStatus('held')).toHaveLength(0)
    expect(s.alertsByStatus('sent')).toHaveLength(2)
  })

  it('quiet end with nothing held sends nothing', async () => {
    const d = deps([box('a@x.com', [])])
    expect(await svc.flushHeld(d, 'quiet_end')).toBe(0)
    expect(d.sends).toHaveLength(0)
  })

  it('paused records but sends nothing, vip included', async () => {
    s.listAdd('vip', 'boss@client.com')
    settings({ pauseUntil: NOON.getTime() + HOUR, pauseStartedAt: NOON.getTime() - HOUR })
    const d = deps([box('a@x.com', [mail(), mail({ from: 'Boss <boss@client.com>' })])])
    const r = await svc.tick(d)
    expect(r.paused).toBe(2)
    expect(r.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
    expect(s.alertsByStatus('paused')).toHaveLength(2)
  })

  it('pause wins over quiet hours', async () => {
    settings({ pauseIndefinite: true, pauseStartedAt: NOON.getTime() })
    const d = deps([box('a@x.com', [mail()])], { now: NIGHT })
    const r = await svc.tick(d)
    expect(r.paused).toBe(1)
    expect(r.held).toBe(0)
  })

  it('pause end sends header then 5 newest with buttons and overflow', async () => {
    settings({ pauseUntil: NOON.getTime() + HOUR, pauseStartedAt: NOON.getTime() - HOUR })
    const mails = Array.from({ length: 8 }, () => mail())
    const during = deps([box('a@x.com', mails)])
    await svc.tick(during)
    expect(s.alertsByStatus('paused')).toHaveLength(8)

    const after = deps([box('a@x.com', [])], { now: new Date(NOON.getTime() + 2 * HOUR) })
    await svc.tick(after)
    expect(after.sends[0]!.text).toBe('Email alerts are back on. 8 critical emails came in while paused.')
    const alerts = after.sends.slice(1, 6)
    expect(alerts).toHaveLength(5)
    for (const a of alerts) expect(a.buttons).toEqual(fmt.ALERT_BUTTONS)
    // Newest first: mails[0] has the latest receivedAt.
    expect(alerts[0]!.text).toContain(mails[0]!.subject)
    expect(after.sends[6]!.text).toContain('3 more')
    expect(after.sends[6]!.buttons).toBeUndefined()
    expect(after.sends).toHaveLength(7)
    expect(s.alertsByStatus('paused')).toHaveLength(0)
    expect(s.alertsByStatus('sent')).toHaveLength(8)
    const st = s.getSettings()
    expect(st.pauseUntil).toBeNull()
    expect(st.pauseStartedAt).toBeNull()
  })

  it('pause end with nothing sends the nothing-critical header', async () => {
    settings({ pauseUntil: NOON.getTime() - 1000, pauseStartedAt: NOON.getTime() - HOUR })
    const d = deps([box('a@x.com', [])])
    await svc.tick(d)
    expect(d.sends).toEqual([
      { text: 'Email alerts are back on. Nothing critical came in while paused.', buttons: undefined },
    ])
  })

  it('indefinite pause never auto-ends', async () => {
    settings({ pauseIndefinite: true, pauseUntil: null, pauseStartedAt: NOON.getTime() - 30 * 24 * HOUR })
    const d = deps([box('a@x.com', [mail()])], { now: new Date(NOON.getTime() + 365 * 24 * HOUR) })
    const r = await svc.tick(d)
    expect(r.paused).toBe(1)
    expect(d.sends).toHaveLength(0)
    expect(s.getSettings().pauseIndefinite).toBe(true)
  })

  it('dedupes the same Message-ID across mailboxes', async () => {
    const m = mail({ rfcMessageId: '<same@x.com>' })
    const d = deps([
      box('a@x.com', [m]),
      box('b@x.com', [{ ...m, msgId: 'other-id' }]),
    ])
    const r = await svc.tick(d)
    expect(r.sent).toBe(1)
    expect(d.triageSpy).toHaveBeenCalledTimes(1)
    expect(d.sends).toHaveLength(1)
  })

  it('one failing mailbox does not stop the others', async () => {
    const bad = box('a@x.com', async () => {
      throw new Error('boom')
    })
    const d = deps([bad, box('b@x.com', [mail()])])
    const r = await svc.tick(d)
    expect(r.sent).toBe(1)
    expect(d.sends).toHaveLength(1)
  })

  it('a failing body read does not stop the tick', async () => {
    const b = box('a@x.com', [mail(), mail()])
    let first = true
    b.body = async () => {
      if (first) {
        first = false
        throw new Error('gone')
      }
      return 'body'
    }
    const d = deps([b])
    const r = await svc.tick(d)
    expect(r.sent).toBe(1)
  })

  it('live tick over the cap sends 5 newest then one overflow line', async () => {
    const mails = Array.from({ length: 7 }, () => mail())
    const d = deps([box('a@x.com', mails)])
    const r = await svc.tick(d)
    expect(r.sent).toBe(7)
    expect(d.sends).toHaveLength(6)
    expect(d.sends[0]!.text).toContain(mails[0]!.subject)
    expect(d.sends[5]!.text).toBe('…and 2 more critical emails in your inbox.')
    expect(s.alertsByStatus('sent')).toHaveLength(7)
  })

  it('daytime failed send retries next tick with no header', async () => {
    const d = deps([box('a@x.com', [mail()])])
    const realSend = d.send
    d.send = async () => null
    const r = await svc.tick(d)
    expect(r.sent).toBe(0)
    expect(s.alertsByStatus('retry')).toHaveLength(1)
    expect(s.alertsByStatus('held')).toHaveLength(0)

    d.send = realSend
    d.now = () => new Date(NOON.getTime() + 10 * 60_000)
    const r2 = await svc.tick(d)
    expect(r2.sent).toBe(1)
    expect(d.sends).toHaveLength(1)
    expect(d.sends[0]!.buttons).toEqual(fmt.ALERT_BUTTONS)
    for (const x of d.sends) expect(x.text).not.toContain('While you were offline')
    expect(s.alertsByStatus('sent')).toHaveLength(1)
  })

  it('three failed sends give up as suppressed', async () => {
    const d = deps([box('a@x.com', [mail()])])
    const realSend = d.send
    d.send = async () => null
    await svc.tick(d)
    await svc.tick(d)
    expect(s.alertsByStatus('retry')).toHaveLength(1)
    log.warn.mockClear()
    await svc.tick(d)
    expect(s.alertsByStatus('retry')).toHaveLength(0)
    const sup = s.alertsByStatus('suppressed')
    expect(sup).toHaveLength(1)
    expect(sup[0]!.attempts).toBe(3)
    const supLines = log.warn.mock.calls.filter((c) => c[1] === 'email-alerts gave up sending')
    expect(supLines).toEqual([[{ suppressed: 1 }, 'email-alerts gave up sending']])
    d.send = realSend
    await svc.tick(d)
    expect(d.sends).toHaveLength(0)
  })

  it('vip retry during quiet hours goes out, non-vip retry waits', async () => {
    const base = { mailbox: 'a@x.com', subject: 'x', reason: 'r', status: 'retry' as const, createdAt: 1 }
    s.insertAlert({ ...base, msgId: 'v', sender: 'Boss <boss@client.com>', reason: 'From a VIP', vip: true })
    s.insertAlert({ ...base, msgId: 'n', sender: 'P <p@client.com>', vip: false })
    const night = deps([box('a@x.com', [])], { now: NIGHT })
    const r = await svc.tick(night)
    expect(r.sent).toBe(1)
    expect(night.sends).toHaveLength(1)
    expect(night.sends[0]!.text).toContain('From a VIP')
    expect(s.alertsByStatus('retry')).toHaveLength(1)

    const morning = deps([box('a@x.com', [])], { now: new Date('2026-10-19T07:05:00Z') })
    await svc.tick(morning)
    expect(morning.sends).toHaveLength(1)
    expect(morning.sends[0]!.text).not.toContain('While you were offline')
    expect(s.alertsByStatus('retry')).toHaveLength(0)
  })

  it('retries respect the 5 cap per tick', async () => {
    for (let i = 0; i < 7; i++) {
      s.insertAlert({ mailbox: 'a@x.com', msgId: `r${i}`, sender: 'P <p@c.com>', subject: 's', reason: 'r', vip: false, status: 'retry', createdAt: i })
    }
    const d = deps([box('a@x.com', [])])
    await svc.tick(d)
    expect(d.sends).toHaveLength(5)
    expect(s.alertsByStatus('retry')).toHaveLength(2)
  })

  it('failed pause-end header leaves the pause, next tick sends the pause-end header', async () => {
    settings({ pauseUntil: NOON.getTime() - 1000, pauseStartedAt: NOON.getTime() - HOUR })
    s.insertAlert({ mailbox: 'a@x.com', msgId: 'p1', sender: 'P <p@c.com>', subject: 's', reason: 'r', vip: false, status: 'paused', createdAt: 1 })
    const d = deps([box('a@x.com', [])])
    const realSend = d.send
    d.send = async () => null
    await svc.tick(d)
    expect(s.alertsByStatus('paused')).toHaveLength(1)
    expect(s.getSettings().pauseUntil).toBe(NOON.getTime() - 1000)

    d.send = realSend
    await svc.tick(d)
    expect(d.sends[0]!.text).toBe('Email alerts are back on. 1 critical emails came in while paused.')
    expect(d.sends).toHaveLength(2)
    expect(s.getSettings().pauseUntil).toBeNull()
    expect(s.alertsByStatus('paused')).toHaveLength(0)
  })

  it('pause ending in quiet hours sends vip now and the summary at quiet end', async () => {
    const end = new Date('2026-10-18T23:30:00Z')
    settings({ pauseUntil: end.getTime(), pauseStartedAt: end.getTime() - HOUR })
    const base = { mailbox: 'a@x.com', subject: 'sub', reason: 'r', status: 'paused' as const, createdAt: 1 }
    s.insertAlert({ ...base, msgId: 'v', sender: 'Boss <boss@client.com>', reason: 'From a VIP', vip: true })
    s.insertAlert({ ...base, msgId: 'n1', sender: 'P1 <p1@client.com>', vip: false })
    s.insertAlert({ ...base, msgId: 'n2', sender: 'P2 <p2@client.com>', vip: false })

    const at = deps([box('a@x.com', [])], { now: end })
    await svc.tick(at)
    expect(at.sends).toHaveLength(1)
    expect(at.sends[0]!.text).toContain('From a VIP')
    expect(at.sends[0]!.buttons).toEqual(fmt.ALERT_BUTTONS)
    expect(s.getSettings().pauseUntil).toBeNull()

    const later = deps([box('a@x.com', [])], { now: new Date(end.getTime() + 10 * 60_000) })
    await svc.tick(later)
    expect(later.sends).toHaveLength(0)

    const morning = deps([box('a@x.com', [])], { now: new Date('2026-10-19T07:00:00Z') })
    await svc.tick(morning)
    expect(morning.sends[0]!.text).toBe('Email alerts are back on. 2 critical emails came in while paused.')
    expect(morning.sends).toHaveLength(3)
    expect(morning.sends[1]!.buttons).toEqual(fmt.ALERT_BUTTONS)
    expect(s.alertsByStatus('paused')).toHaveLength(0)
    expect(s.getSettings().pauseSummaryPending).toBe(false)

    const after = deps([box('a@x.com', [])], { now: new Date('2026-10-19T07:10:00Z') })
    await svc.tick(after)
    expect(after.sends).toHaveLength(0)
  })

  it('log line carries counts only', async () => {
    s.listAdd('vip', 'boss@client.com')
    const d = deps([
      box('a@x.com', [
        mail({ from: 'Secret Sender <secret@client.com>', subject: 'Top secret subject' }),
        mail({ from: 'Boss <boss@client.com>', subject: 'Boss subject' }),
      ]),
    ])
    await svc.tick(d)
    const all = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    for (const needle of ['Secret Sender', 'secret@client.com', 'Top secret subject', 'boss@client.com', 'Boss subject']) {
      expect(all).not.toContain(needle)
    }
    const tickLines = log.info.mock.calls.filter((c) => c[1] === 'email-alerts tick')
    expect(tickLines).toHaveLength(1)
    expect(Object.keys(tickLines[0]![0] as object).sort()).toEqual(['held', 'paused', 'sent', 'triaged'])
  })

  it('no log line when nothing happened', async () => {
    const d = deps([box('a@x.com', [])])
    await svc.tick(d)
    expect(log.info.mock.calls.filter((c) => c[1] === 'email-alerts tick')).toHaveLength(0)
  })
})

describe('startEmailAlerts', () => {
  it('first pass after 2 minutes, never overlaps, never throws', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      let release: () => void = () => {}
      const d = deps([])
      d.boxes = () => {
        calls++
        return new Promise((res) => {
          release = () => res({ boxes: [], broken: [] })
        })
      }
      const stop = svc.startEmailAlerts(d)
      await vi.advanceTimersByTimeAsync(119_000)
      expect(calls).toBe(0)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls).toBe(1)
      // Still in flight: the interval tick must not start a second pass.
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(calls).toBe(1)
      release()
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(calls).toBe(2)
      release()
      // A throwing pass is swallowed.
      d.boxes = async () => {
        calls++
        throw new Error('boom')
      }
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(calls).toBe(3)
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(calls).toBe(4)
      stop()
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS * 3)
      expect(calls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
