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
    expect(fmt.formatOverflow(1)).toBe('…and 1 more critical email in your inbox.')
  })
  it('plural headers', () => {
    expect(fmt.pauseEndHeader(1)).toBe('Email alerts are back on. 1 critical email came in while paused.')
    expect(fmt.pauseEndHeader(2)).toBe('Email alerts are back on. 2 critical emails came in while paused.')
    expect(fmt.quietEndHeader(1)).toBe('While you were offline: 1 critical email.')
    expect(fmt.quietEndHeader(3)).toBe('While you were offline: 3 critical emails.')
  })
  it('email text never becomes a working link', () => {
    const base = {
      id: 1, mailbox: 'a@x.com', msgId: 'm', vip: false, status: 'sent' as const, createdAt: 0, sentAt: null,
      chatId: null, chatMessageId: null, feedback: null, actions: [], attempts: 0,
    }
    const LINK = /\[[^\]]*\]\(|<https?:|https?:\/\//i
    for (const evil of ['[Your invoice](https://evil)', '<https://evil|Bank notice>']) {
      const text = fmt.formatAlert({
        ...base,
        sender: `${evil} <jane@x.com>`,
        subject: evil,
        reason: `See ${evil}`,
      })
      expect(text).not.toMatch(LINK)
      // Every bracket that could open link syntax is escaped or replaced.
      const [senderL, subjectL, reasonL] = text.split('\n')
      for (const l of [subjectL!, reasonL!]) expect(l.replace(/\\./g, '')).not.toMatch(/[[\]()<>]/)
      // The sender line's own "(address)" is ours; the name part is neutralised.
      expect(senderL!.replace(/ \(jane@x\.com\)$/, '').replace(/\\./g, '')).not.toMatch(/[[\]()<>]/)
      expect(text).toContain('hxxps://evil')
    }
    const plain = fmt.formatAlert({ ...base, sender: 'Jane Doe <jane@x.com>', subject: 'Site down', reason: 'Client says so' })
    expect(plain).toBe('Jane Doe (jane@x.com)\nSite down\nClient says so')
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

  it("an owner reply in a thread is not triaged", async () => {
    const d = deps([box('a@x.com', [mail({ from: 'Me <A@x.com>' }), mail({ from: 'a@x.com' })])])
    const r = await svc.tick(d)
    expect(d.triageSpy).not.toHaveBeenCalled()
    expect(r.sent).toBe(0)
    expect(d.sends).toHaveLength(0)
  })

  it('passes an isSeen predicate so seen ids skip their fetch', async () => {
    const m = mail()
    const preds: ((id: string) => boolean)[] = []
    const b: Mailbox = {
      id: 'a@x.com',
      provider: 'gmail',
      list: async (_since, isSeen) => {
        if (isSeen) preds.push(isSeen)
        return [m]
      },
      body: async () => 'body',
    }
    const d = deps([b])
    await svc.tick(d)
    expect(preds[0]!(m.msgId)).toBe(true)
    expect(preds[0]!('never')).toBe(false)
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
    expect(d.sends[0]!.text).toBe('Email alerts are back on. 1 critical email came in while paused.')
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

  it('a stuck tick releases the overlap guard after the ceiling', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const d = deps([])
      d.boxes = () => {
        calls++
        return new Promise(() => {}) // never settles
      }
      const stop = svc.startEmailAlerts(d)
      await vi.advanceTimersByTimeAsync(121_000)
      expect(calls).toBe(1)
      expect(log.warn.mock.calls.some((c) => c[1] === 'email-alerts tick timed out')).toBe(false)
      await vi.advanceTimersByTimeAsync(svc.TICK_CEILING_MS)
      const warn = log.warn.mock.calls.find((c) => c[1] === 'email-alerts tick timed out')
      expect(warn).toBeDefined()
      expect(warn![0]).toEqual({})
      // The guard is free again: the next interval starts a new pass.
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(calls).toBe(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('abandoned ticks', () => {
  type Row = Parameters<Store['insertAlert']>[0]
  function seed(subject: string, over: Partial<Row> = {}): number {
    return s.insertAlert({
      mailbox: 'a@x.com',
      msgId: subject,
      sender: `Sender <${subject.toLowerCase().replace(/\s/g, '')}@client.com>`,
      subject,
      reason: 'Needs you',
      vip: false,
      status: 'held',
      createdAt: NOON.getTime() - 60_000,
      ...over,
    })
  }

  /** A send that hangs on the call whose text matches `stuckOn`, until released. */
  function stuckSend(d: ReturnType<typeof deps>, stuckOn: (text: string) => boolean) {
    let release: () => void = () => {}
    let stuck = false
    let n = 0
    d.send = async (text, buttons) => {
      d.sends.push({ text, buttons })
      n++
      const id = String(n)
      if (!stuck && stuckOn(text)) {
        stuck = true
        await new Promise<void>((res) => {
          release = res
        })
      }
      return { chatId: 'chat1', messageId: id }
    }
    return { release: () => release() }
  }

  const count = (d: ReturnType<typeof deps>, needle: string) => d.sends.filter((x) => x.text.includes(needle)).length

  /** First pass at 2 minutes, abandoned at the ceiling, the next pass at 20 minutes. */
  async function toSecondPass(): Promise<void> {
    await vi.advanceTimersByTimeAsync(121_000)
    await vi.advanceTimersByTimeAsync(2 * svc.INTERVAL_MS - 121_000 + 1_000)
  }

  it('(a) a flush row stuck past the ceiling: the next tick delivers the rest, nothing goes twice', async () => {
    vi.useFakeTimers()
    try {
      seed('Held 1', { createdAt: NOON.getTime() - 3_000 })
      seed('Held 2', { createdAt: NOON.getTime() - 2_000 })
      seed('Held 3', { createdAt: NOON.getTime() - 1_000 })
      const d = deps([box('a@x.com', [])])
      let boxCalls = 0
      d.boxes = async () => {
        boxCalls++
        return { boxes: [], broken: [] }
      }
      const gate = stuckSend(d, (t) => t.includes('Held 3')) // newest first: the first row
      const stop = svc.startEmailAlerts(d)
      await vi.advanceTimersByTimeAsync(121_000)
      expect(d.sends.map((x) => x.text.split('\n')[0])).toEqual([
        'While you were offline: 3 critical emails.',
        expect.stringContaining('held3@client.com'),
      ])
      expect(boxCalls).toBe(0)
      await vi.advanceTimersByTimeAsync(2 * svc.INTERVAL_MS - 121_000 + 1_000)
      // Tick B: no second header, the in-flight row is left alone, the rest go.
      expect(count(d, 'While you were offline')).toBe(1)
      expect(count(d, 'Held 3')).toBe(1)
      expect(count(d, 'Held 2')).toBe(1)
      expect(count(d, 'Held 1')).toBe(1)
      expect(boxCalls).toBe(1)
      const before = d.sends.length
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
      // A records its one send and stops: no more sends, no mail read.
      expect(d.sends.length).toBe(before)
      expect(boxCalls).toBe(1)
      expect(s.alertsByStatus('sent').map((r) => r.subject).sort()).toEqual(['Held 1', 'Held 2', 'Held 3'])
      expect(s.alertsByStatus('due')).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('(a) a stuck quiet-end header: no second header, and the rows go out once afterwards', async () => {
    vi.useFakeTimers()
    try {
      seed('Held 1')
      seed('Held 2')
      const d = deps([])
      d.boxes = async () => ({ boxes: [], broken: [] })
      const gate = stuckSend(d, (t) => t.startsWith('While you were offline'))
      const stop = svc.startEmailAlerts(d)
      await toSecondPass()
      expect(d.sends).toHaveLength(1)
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(d.sends).toHaveLength(1) // A stopped after its header
      expect(s.alertsByStatus('due')).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(count(d, 'While you were offline')).toBe(1)
      expect(count(d, 'Held 1')).toBe(1)
      expect(count(d, 'Held 2')).toBe(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('(b) a retry row stuck past the ceiling: the next tick sends the other, nothing goes twice', async () => {
    vi.useFakeTimers()
    try {
      seed('Retry 1', { status: 'retry', createdAt: NOON.getTime() - 2_000 })
      seed('Retry 2', { status: 'retry', createdAt: NOON.getTime() - 1_000 })
      const d = deps([])
      let boxCalls = 0
      d.boxes = async () => {
        boxCalls++
        return { boxes: [], broken: [] }
      }
      const gate = stuckSend(d, (t) => t.includes('Retry 2'))
      const stop = svc.startEmailAlerts(d)
      await toSecondPass()
      expect(count(d, 'Retry 2')).toBe(1)
      expect(count(d, 'Retry 1')).toBe(1)
      expect(boxCalls).toBe(1)
      const before = d.sends.length
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(d.sends.length).toBe(before)
      expect(boxCalls).toBe(1)
      expect(s.alertsByStatus('sent').map((r) => r.subject).sort()).toEqual(['Retry 1', 'Retry 2'])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('(c) a stuck pause-end header goes out once, and its rows once, with the pause cleared', async () => {
    vi.useFakeTimers()
    try {
      settings({ pauseUntil: NOON.getTime() - HOUR, pauseStartedAt: NOON.getTime() - 3 * HOUR })
      seed('Paused 1', { status: 'paused' })
      seed('Paused 2', { status: 'paused' })
      const d = deps([])
      d.boxes = async () => ({ boxes: [], broken: [] })
      const gate = stuckSend(d, (t) => t.startsWith('Email alerts are back on'))
      const stop = svc.startEmailAlerts(d)
      await toSecondPass()
      expect(d.sends).toHaveLength(1)
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(d.sends).toHaveLength(1)
      expect(s.getSettings().pauseUntil).toBeNull()
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(count(d, 'Email alerts are back on. 2 critical emails came in while paused.')).toBe(1)
      expect(count(d, 'Paused 1')).toBe(1)
      expect(count(d, 'Paused 2')).toBe(1)
      expect(d.sends).toHaveLength(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('mail an abandoned tick already read is recorded for the next tick, never lost or sent twice', async () => {
    vi.useFakeTimers()
    try {
      const m1 = mail({ subject: 'First' })
      const m2 = mail({ subject: 'Second' })
      const d = deps([box('a@x.com', [m1, m2])])
      let release: () => void = () => {}
      let calls = 0
      d.triage = async () => {
        calls++
        if (calls === 1) {
          await new Promise<void>((res) => {
            release = res
          })
        }
        return critical()
      }
      const stop = svc.startEmailAlerts(d)
      await toSecondPass()
      // B skipped First (A marked it seen) and alerted on Second.
      expect(count(d, 'First')).toBe(0)
      expect(count(d, 'Second')).toBe(1)
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(count(d, 'First')).toBe(0)
      expect(s.alertsByStatus('due').map((r) => r.subject)).toEqual(['First'])
      await vi.advanceTimersByTimeAsync(svc.INTERVAL_MS)
      expect(count(d, 'First')).toBe(1)
      expect(count(d, 'Second')).toBe(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a held or retry row another tick already sent is skipped at send time', async () => {
    const r1 = seed('Retry A', { status: 'retry', createdAt: NOON.getTime() - 1_000 })
    const r2 = seed('Retry B', { status: 'retry', createdAt: NOON.getTime() - 2_000 })
    const d = deps([box('a@x.com', [])])
    const inner = d.send
    d.send = async (text, buttons) => {
      // While Retry A goes out, a concurrent tick handles Retry B.
      if (text.includes('Retry A')) s.markAlertSent(r2, 'chat1', 'other', NOON.getTime())
      return inner(text, buttons)
    }
    await svc.tick(d)
    expect(count(d, 'Retry A')).toBe(1)
    expect(count(d, 'Retry B')).toBe(0)
    expect(s.findAlertById(r1)!.status).toBe('sent')
    expect(s.findAlertById(r2)!.chatMessageId).toBe('other')
  })

  it('a pause-end flush re-checks the pause before its header', async () => {
    seed('Paused X', { status: 'paused' })
    const d = deps([])
    // No pause is over: nothing to summarise, no header.
    expect(await svc.flushHeld(d, 'pause_end')).toBe(0)
    expect(d.sends).toHaveLength(0)
  })

  it('a new pause set while the pause-end header goes out is kept, and its rows wait', async () => {
    settings({ pauseUntil: NOON.getTime() - HOUR })
    seed('Paused Y', { status: 'paused' })
    const d = deps([box('a@x.com', [])])
    const inner = d.send
    d.send = async (text, buttons) => {
      if (text.startsWith('Email alerts are back on')) {
        s.saveSettings({ ...s.getSettings(), pauseUntil: NOON.getTime() + HOUR })
      }
      return inner(text, buttons)
    }
    await svc.tick(d)
    expect(d.sends.map((x) => x.text)).toEqual(['Email alerts are back on. 1 critical email came in while paused.'])
    expect(s.getSettings().pauseUntil).toBe(NOON.getTime() + HOUR)
    expect(s.alertsByStatus('due').map((r) => r.subject)).toEqual(['Paused Y'])
  })
})

describe('due rows and quiet hours', () => {
  function due(subject: string, vip: boolean): number {
    return s.insertAlert({
      mailbox: 'a@x.com', msgId: subject, sender: `S <${subject.toLowerCase()}@client.com>`, subject,
      reason: 'Needs you', vip, status: 'due', createdAt: NIGHT.getTime() - 60_000,
    })
  }

  it('a non-VIP due row waits through quiet hours and goes out after them, with no header', async () => {
    const id = due('Plain', false)
    const night = deps([box('a@x.com', [])], { now: NIGHT })
    await svc.tick(night)
    expect(night.sends).toHaveLength(0)
    expect(s.findAlertById(id)!.status).toBe('due')
    const morning = deps([box('a@x.com', [])], { now: new Date('2026-10-19T07:05:00Z') })
    await svc.tick(morning)
    expect(morning.sends.map((x) => x.text.split('\n')[1])).toEqual(['Plain'])
    expect(s.findAlertById(id)!.status).toBe('sent')
  })

  it('a VIP due row goes out during quiet hours', async () => {
    due('Boss', true)
    const night = deps([box('a@x.com', [])], { now: NIGHT })
    await svc.tick(night)
    expect(night.sends.map((x) => x.text.split('\n')[1])).toEqual(['Boss'])
  })
})

describe('format modes', () => {
  const base = {
    id: 1, mailbox: 'a@x.com', msgId: 'm', vip: false, status: 'sent' as const, createdAt: 0, sentAt: null,
    chatId: null, chatMessageId: null, feedback: null, actions: [], attempts: 0,
  }

  it('plain (Telegram) shows email text without backslash escapes', () => {
    const text = fmt.formatAlert(
      { ...base, sender: 'Jane_Doe <jane@x.com>', subject: 'Q3_report (final)', reason: 'Asks for *the* [draft]' },
      'plain'
    )
    expect(text).toBe('Jane_Doe (jane@x.com)\nQ3_report (final)\nAsks for *the* [draft]')
    expect(text).not.toContain('\\')
  })

  it('plain still swaps angle brackets and defangs URLs', () => {
    const text = fmt.formatAlert({ ...base, sender: 'a@x.com', subject: '<https://evil|x> see http://y', reason: 'r' }, 'plain')
    expect(text.split('\n')[1]).toBe('‹hxxps://evil|x› see hxxp://y')
  })

  it('markdown (Teams, Slack) still stops [x](https://evil) and <https://evil|x> forming links', () => {
    const LINK = /\[[^\]]*\]\(|<https?:|https?:\/\//i
    for (const evil of ['[x](https://evil)', '<https://evil|x>']) {
      const text = fmt.formatAlert({ ...base, sender: 'a@x.com', subject: evil, reason: evil }, 'markdown')
      expect(text).not.toMatch(LINK)
      expect(text.split('\n')[1]!.replace(/\\./g, '')).not.toMatch(/[[\]()<>]/)
    }
    expect(fmt.formatAlert({ ...base, sender: 'a@x.com', subject: 'Q3_report (final)', reason: 'r' }, 'markdown')).toContain(
      'Q3\\_report \\(final\\)'
    )
  })

  it('the tick sends in the adapter mode it is given', async () => {
    const d = deps([box('a@x.com', [mail({ subject: 'Q3_report (final)' })])])
    d.format = 'plain'
    await svc.tick(d)
    expect(d.sends[0]!.text.split('\n')[1]).toBe('Q3_report (final)')
    const m = deps([box('a@x.com', [mail({ subject: 'Q4_report (final)' })])])
    await svc.tick(m) // default: markdown
    expect(m.sends[0]!.text.split('\n')[1]).toBe('Q4\\_report \\(final\\)')
  })
})

describe('own-address skip', () => {
  it('an Outlook box labelled default skips mail from its own /me address', async () => {
    settings({ seededMailboxes: ['default'] })
    const own = mail({ from: 'Me <Me@Corp.com>', subject: 'My reply' })
    const other = mail({ from: 'Client <c@client.com>', subject: 'Their ask' })
    const b: Mailbox = { ...box('default', [own, other]), provider: 'outlook', address: 'me@corp.com' }
    const d = deps([b])
    await svc.tick(d)
    expect(d.sends.map((x) => x.text.split('\n')[1])).toEqual(['Their ask'])
  })
})
