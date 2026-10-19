import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-email-alerts-ctl-'))
process.env['AGENT_STORE_DIR'] = STORE

type Store = typeof import('../src/email-alerts/store.js')
type Ctl = typeof import('../src/email-alerts/control.js')
type Svc = typeof import('../src/email-alerts/service.js')
type Db = typeof import('../src/db.js')
type Sources = typeof import('../src/email-alerts/sources.js')
type Triage = typeof import('../src/email-alerts/triage.js')
let s: Store
let c: Ctl
let svc: Svc
let dbm: Db

const TZ = 'America/Toronto'
const NOW = new Date('2026-10-18T15:00:00Z') // 11:00 am Toronto, outside quiet hours
const DAY = 86_400_000

type Mailbox = Awaited<ReturnType<Sources['discoverMailboxes']>>['boxes'][number]
type NewMail = Awaited<ReturnType<Mailbox['list']>>[number]
type TriageInput = Parameters<Triage['triage']>[0]
type TriageOutcome = Awaited<ReturnType<Triage['triage']>>

function mail(id: string, from: string, subject: string, ageMs: number, extra: Partial<NewMail['headers']> = {}): NewMail {
  return {
    mailbox: 'a@x.com',
    msgId: id,
    rfcMessageId: `<${id}@x>`,
    receivedAt: NOW.getTime() - ageMs,
    headers: { from, ...extra },
    subject,
  }
}

function box(mails: NewMail[], bodies: Record<string, string | Error> = {}): Mailbox & { listedSince: number[] } {
  const listedSince: number[] = []
  return {
    id: 'a@x.com',
    provider: 'gmail',
    listedSince,
    async list(sinceMs: number) {
      listedSince.push(sinceMs)
      return mails.filter((m) => m.receivedAt >= sinceMs)
    },
    async body(msgId: string) {
      const b = bodies[msgId]
      if (b instanceof Error) throw b
      return b ?? 'hello'
    },
  }
}

function deps(over: {
  boxes?: Mailbox[]
  broken?: { id: string; why: string }[]
  triage?: (i: TriageInput) => Promise<TriageOutcome>
} = {}) {
  return {
    boxes: async () => ({ boxes: over.boxes ?? [], broken: over.broken ?? [] }),
    triage: over.triage ?? (async () => ({ kind: 'failed' }) as TriageOutcome),
    now: () => NOW,
    tz: TZ,
  }
}

const run = (argv: string, d = deps()) => c.runControl(argv.split(' ').filter(Boolean), d)

function count(table: string): number {
  return (dbm.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

beforeAll(async () => {
  dbm = await import('../src/db.js')
  dbm.initDatabase()
  s = await import('../src/email-alerts/store.js')
  c = await import('../src/email-alerts/control.js')
  svc = await import('../src/email-alerts/service.js')
})

beforeEach(() => {
  const d = dbm.getDb()
  for (const t of ['email_alerts', 'email_alert_lists', 'email_alert_menus', 'email_alert_seen', 'email_alert_triage_counts'])
    d.exec(`DELETE FROM ${t}`)
  d.exec(`DELETE FROM app_state WHERE key LIKE 'email_alerts.%'`)
})

describe('runControl', () => {
  it('status starts with the off line by default', async () => {
    const out = await run('status')
    expect(out.split('\n')[0]).toBe('Email alerts are off.')
  })

  it('on then status shows on', async () => {
    expect(await run('on')).toBe('Email alerts are on.')
    expect(s.getSettings().enabled).toBe(true)
    const out = await run('status')
    const lines = out.split('\n')
    expect(lines[0]).toBe('Email alerts are on.')
    expect(lines).toContain('Quiet hours: 22:00 to 07:00.')
    expect(lines).toContain('VIPs: 0. Muted: 0.')
    expect(lines).toContain('Last 7 days: 0 alerts, 0 marked useful, 0 not urgent')
    expect(await run('off')).toBe('Email alerts are off.')
    expect(s.getSettings().enabled).toBe(false)
  })

  it('pause tomorrow reports local time', async () => {
    await run('on')
    expect(await run('pause tomorrow')).toBe('Email alerts paused until 7:00 am tomorrow.')
    expect(s.getSettings().pauseUntil).toBe(new Date('2026-10-19T11:00:00Z').getTime())
    expect((await run('status')).split('\n')).toContain('Paused until 7:00 am tomorrow.')
  })

  it('pause off pauses until turned back on', async () => {
    expect(await run('pause off')).toBe('Email alerts paused until you turn them back on.')
    expect(s.getSettings().pauseIndefinite).toBe(true)
    expect((await run('status')).split('\n')).toContain('Paused until you turn them back on.')
  })

  it('pause until an ISO time in the future', async () => {
    expect(await run('pause until 2026-10-18T20:30:00Z')).toBe('Email alerts paused until 4:30 pm.')
    const st = s.getSettings()
    expect(st.pauseUntil).toBe(new Date('2026-10-18T20:30:00Z').getTime())
    expect(st.pauseIndefinite).toBe(false)
    expect(st.pauseStartedAt).toBe(NOW.getTime())
  })

  it('pause until takes an offset form too', async () => {
    expect(await run('pause until 2026-10-19T09:15:00-04:00')).toBe('Email alerts paused until 9:15 am tomorrow.')
  })

  it('pause until refuses the past, over 30 days and nonsense', async () => {
    for (const arg of ['2026-10-18T10:00:00Z', '2026-12-01T10:00:00Z', 'soonish', '2026-10-18T20:30', 'Oct 19']) {
      const out = await run(`pause until ${arg}`)
      expect(out).not.toMatch(/paused until/)
      expect(out).not.toContain('—')
    }
    expect(s.getSettings().pauseUntil).toBeNull()
    expect(await run('pause sometime')).not.toMatch(/paused until/)
  })

  it('resume ends the pause', async () => {
    await run('on')
    await run('pause 1w')
    expect(await run('resume')).toBe(
      'Email alerts are back on. Anything critical from the pause comes through in the next few minutes.'
    )
    const st = s.getSettings()
    expect(st.pauseIndefinite).toBe(false)
    expect(st.pauseUntil).toBe(NOW.getTime())
    expect(st.enabled).toBe(true)
    expect((await run('status')).split('\n').some((l) => l.startsWith('Paused'))).toBe(false)

    // The next tick ends the pause through the normal path.
    const sent: string[] = []
    await svc.tick({
      boxes: async () => ({ boxes: [], broken: [] }),
      triage: async () => ({ kind: 'failed' }),
      send: async (text) => {
        sent.push(text)
        return { chatId: 'c1', messageId: String(sent.length) }
      },
      now: () => NOW,
      tz: TZ,
    })
    expect(sent).toEqual(['Email alerts are back on. Nothing critical came in while paused.'])
    expect(s.getSettings().pauseUntil).toBeNull()
  })

  it('resume from an indefinite pause also clears it', async () => {
    await run('pause off')
    await run('resume')
    expect(s.getSettings().pauseIndefinite).toBe(false)
    expect(s.getSettings().pauseUntil).toBe(NOW.getTime())
  })

  it('resume with no pause says so', async () => {
    expect(await run('resume')).toBe("Email alerts aren't paused.")
    expect(s.getSettings().pauseUntil).toBeNull()
  })

  it('status names a broken mailbox', async () => {
    const out = await run('status', deps({ broken: [{ id: 'b@x.com', why: 'Outlook needs reconnecting for b@x.com.' }] }))
    expect(out.split('\n')).toContain('Outlook needs reconnecting for b@x.com.')
  })

  it('status shows the cap line when 300 reached', async () => {
    await run('on')
    const day = '2026-10-18'
    dbm.getDb().prepare('INSERT INTO email_alert_triage_counts (day, count) VALUES (?, 300)').run(day)
    const out = await run('status', deps({ boxes: [box([])] }))
    expect(out.split('\n')).toContain('Daily limit reached today, only VIP alerts until tomorrow.')
    dbm.getDb().prepare('UPDATE email_alert_triage_counts SET count = 299 WHERE day = ?').run(day)
    expect(await run('status')).not.toContain('Daily limit')
  })

  it('status counts the last 7 days and the lists', async () => {
    const mk = (sentAt: number, fb: 'useful' | 'not_urgent' | null) => {
      const id = s.insertAlert({
        mailbox: 'a@x.com', msgId: `m${sentAt}`, sender: 'x@y.com', subject: 's', reason: 'r',
        vip: false, status: 'held', createdAt: sentAt,
      })
      s.markAlertSent(id, 'c1', String(id), sentAt)
      if (fb) s.setFeedback(id, fb)
    }
    mk(NOW.getTime() - DAY, 'useful')
    mk(NOW.getTime() - 2 * DAY, 'not_urgent')
    mk(NOW.getTime() - 3 * DAY, null)
    mk(NOW.getTime() - 8 * DAY, 'useful')
    await run('vip add boss@x.com')
    await run('vip add acme.com')
    await run('mute add spam.com')
    const lines = (await run('status')).split('\n')
    expect(lines).toContain('Last 7 days: 3 alerts, 1 marked useful, 1 not urgent')
    expect(lines).toContain('VIPs: 2. Muted: 1.')
  })

  it('vip add normalises case', async () => {
    expect(await run('vip add Boss@Acme.COM')).toBe('Added boss@acme.com to your VIPs.')
    await run('vip add *@Example.org')
    await run('vip add @Other.net')
    expect(s.listAll('vip')).toEqual(['boss@acme.com', 'example.org', 'other.net'])
    expect(await run('vip list')).toBe('VIPs: boss@acme.com, example.org, other.net')
    expect(await run('vip remove @EXAMPLE.org')).toBe('Removed example.org from your VIPs.')
    expect(await run('vip remove nobody@x.com')).toBe("nobody@x.com isn't on your VIP list.")
    expect(await run('vip add not an address')).not.toMatch(/^Added/)
  })

  it('mute add normalises, and the newest list wins for the same entry', async () => {
    await run('vip add acme.com')
    expect(await run('mute add *@ACME.com')).toBe('Muted acme.com.')
    expect(s.listAll('mute')).toEqual(['acme.com'])
    expect(s.listAll('vip')).toEqual([])
    expect(await run('mute list')).toBe('Muted: acme.com')
    expect(await run('mute remove acme.com')).toBe('Unmuted acme.com.')
    expect(await run('mute list')).toBe('Nobody is muted.')
    expect(await run('vip list')).toBe('No VIPs yet.')
  })

  it('quiet sets the hours and refuses bad times', async () => {
    expect(await run('quiet 23:00 06:30')).toBe('Quiet hours are now 23:00 to 06:30.')
    expect(s.getSettings().quietStart).toBe('23:00')
    expect(s.getSettings().quietEnd).toBe('06:30')
    for (const bad of ['quiet 24:00 06:00', 'quiet 7:00 08:00', 'quiet 22:00', 'quiet 22:60 07:00']) {
      expect(await run(bad)).not.toMatch(/^Quiet hours are now/)
    }
    expect(s.getSettings().quietStart).toBe('23:00')
  })

  it('replay does not mark seen, insert or bump the cap', async () => {
    await run('vip add boss@x.com')
    await run('mute add spam.com')
    const day = '2026-10-18'
    dbm.getDb().prepare('INSERT INTO email_alert_triage_counts (day, count) VALUES (?, 300)').run(day)
    const prompts: string[] = []
    const triage = c.replayTriage(async (p) => {
      prompts.push(p)
      return p.includes('Server down')
        ? '{"critical":true,"reason":"Production outage"}'
        : '{"critical":false,"reason":"FYI"}'
    }, () => NOW, TZ)
    const b = box(
      [
        mail('m1', 'Boss <boss@x.com>', 'Lunch?', 1 * 3_600_000),
        mail('m2', 'Ops <ops@client.com>', 'Server down', 2 * 3_600_000),
        mail('m3', 'Ann <ann@client.com>', 'FYI notes', 3 * 3_600_000),
        mail('m4', 'Promo <deals@spam.com>', 'Server down sale', 4 * 3_600_000),
        mail('m5', 'noreply@shop.com', 'Server down receipt', 5 * 3_600_000),
        mail('m6', 'Joe <joe@client.com>', 'Server down too', 6 * 3_600_000),
        mail('m7', 'Old <old@client.com>', 'Server down long ago', 5 * DAY),
      ],
      { m6: new Error('fetch failed') }
    )
    const out = await run('replay 3', deps({ boxes: [b], triage }))
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^Oct 18 10:00 am {2}boss@x\.com {2}Lunch\? {2}From a VIP$/)
    expect(lines[1]).toMatch(/^Oct 18 9:00 am {2}ops@client\.com {2}Server down {2}Production outage$/)
    expect(b.listedSince).toEqual([NOW.getTime() - 3 * DAY])
    expect(prompts).toHaveLength(2) // m2 and m3; VIP, mute, automated and body failure skip the model
    expect(count('email_alert_seen')).toBe(0)
    expect(count('email_alerts')).toBe(0)
    expect(s.triageCount(day)).toBe(300)
  })

  it('replay says so when nothing would have alerted, and caps at 30 lines', async () => {
    expect(await run('replay 2', deps({ boxes: [box([])] }))).toBe('Nothing would have alerted in the last 2 days.')
    const many = Array.from({ length: 40 }, (_, i) => mail(`v${i}`, 'boss@x.com', `Note ${i}`, (i + 1) * 60_000))
    await run('vip add boss@x.com')
    const lines = (await run('replay 1', deps({ boxes: [box(many)] }))).split('\n')
    expect(lines).toHaveLength(30)
    expect(lines[0]).toContain('Note 0')
    expect(lines[29]).toBe('…and 11 more.')
  })

  it('replay over 14 days is refused in plain words', async () => {
    const b = box([])
    const out = await run('replay 15', deps({ boxes: [b] }))
    expect(out).toBe('Replay can look back 14 days at most.')
    expect(b.listedSince).toEqual([])
    expect(await run('replay', deps({ boxes: [b] }))).toBe('Replay needs a number of days, from 1 to 14.')
    expect(await run('replay 0', deps({ boxes: [b] }))).toBe('Replay needs a number of days, from 1 to 14.')
  })

  it('an unknown command lists what it can do, with no em dashes', async () => {
    const out = await run('frobnicate')
    expect(out).toContain('status')
    expect(out).not.toContain('—')
  })
})

describe('email-alerts skill', () => {
  it('ships always on, with only placeholders an update can fill, and no em dashes', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { ALWAYS_ON_SKILLS } = await import('../src/skills/sync.js')
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'skills', 'email-alerts')
    const skill = readFileSync(resolve(dir, 'SKILL.md'), 'utf-8')
    const manifestRaw = readFileSync(resolve(dir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as { id: string; enabled: boolean; triggers: string[] }
    expect(ALWAYS_ON_SKILLS).toContain('email-alerts')
    expect(manifest.id).toBe('email-alerts')
    expect(manifest.enabled).toBe(true)
    expect(manifest.triggers).toEqual(['email alert', 'alerts', 'vip', 'pause alerts', 'mute'])
    const used = new Set([...`${skill}${manifestRaw}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
    expect([...used]).toEqual(['PROJECT_PATH'])
    expect(skill).toContain('node {{PROJECT_PATH}}/dist/scripts/email-alerts.js')
    expect(skill).toContain('pause until <ISO time>')
    expect(skill).toMatch(/Do not explain how alerts work/)
    for (const phrase of ['turn on email alerts', 'pause my email alerts for', 'always tell me when', 'stop alerting me about', 'email alert status'])
      expect(skill).toContain(phrase)
    expect(`${skill}${manifestRaw}`).not.toContain('—')
  })
})
