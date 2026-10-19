import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-email-alerts-btn-'))
process.env['AGENT_STORE_DIR'] = STORE

type Store = typeof import('../src/email-alerts/store.js')
type Btn = typeof import('../src/email-alerts/buttons.js')
type Db = typeof import('../src/db.js')
let s: Store
let b: Btn
let dbm: Db

const NOW = new Date('2026-10-18T15:00:00Z') // 11:00 am Toronto
const sent: { text: string; buttons?: string[] }[] = []
let nextId = 100
const io = () => ({
  send: async (text: string, buttons?: string[]) => {
    sent.push({ text, buttons })
    return { chatId: 'c1', messageId: String(nextId++) }
  },
  now: () => NOW,
  tz: 'America/Toronto',
})

function makeAlert(): number {
  const id = s.insertAlert({
    mailbox: 'a@x.com',
    msgId: 'm1',
    sender: 'Boss <boss@x.com>',
    subject: 'Server down',
    reason: 'outage',
    vip: false,
    status: 'held',
    createdAt: 1000,
  })
  s.markAlertSent(id, 'c1', '50', 2000)
  return id
}

beforeAll(async () => {
  dbm = await import('../src/db.js')
  dbm.initDatabase()
  s = await import('../src/email-alerts/store.js')
  b = await import('../src/email-alerts/buttons.js')
})

beforeEach(() => {
  const d = dbm.getDb()
  for (const t of ['email_alerts', 'email_alert_lists', 'email_alert_menus']) d.exec(`DELETE FROM ${t}`)
  d.exec(`DELETE FROM app_state WHERE key LIKE 'email_alerts.%'`)
  sent.length = 0
  nextId = 100
})

describe('alert buttons', () => {
  it('Useful then Mute both apply on one alert', async () => {
    const id = makeAlert()
    expect(await b.handleAlertClick('c1', '50', 'Useful', io())).toBe(true)
    expect(await b.handleAlertClick('c1', '50', 'Mute sender', io())).toBe(true)
    expect(s.findAlertByChatMessage('c1', '50')?.feedback).toBe('useful')
    expect(s.listAll('mute')).toEqual(['boss@x.com'])
    expect(sent.map((m) => m.text)).toEqual(['Noted.', 'Muted boss@x.com.'])
    expect(sent[1]!.buttons).toEqual(['Undo mute'])
    expect(s.findMenu('c1', '101')).toEqual({ kind: 'undo_mute', alertId: id })
    expect(await b.handleAlertClick('c1', '101', 'Undo mute', io())).toBe(true)
    expect(s.listAll('mute')).toEqual([])
    expect(sent[2]!.text).toBe('Unmuted boss@x.com.')
  })

  it('Useful twice is ignored the second time', async () => {
    makeAlert()
    await b.handleAlertClick('c1', '50', 'Useful', io())
    await b.handleAlertClick('c1', '50', 'Useful', io())
    expect(sent.map((m) => m.text)).toEqual(['Noted.', 'Already done.'])
  })

  it('Pause opens the duration menu and 1 week sets pauseUntil', async () => {
    makeAlert()
    s.saveSettings({ ...s.getSettings(), enabled: true, seededMailboxes: ['a@x.com'] })
    await b.handleAlertClick('c1', '50', 'Pause alerts', io())
    expect(sent[0]).toEqual({ text: 'How long?', buttons: b.PAUSE_BUTTONS })
    await b.handleAlertClick('c1', '100', '1 week', io())
    const st = s.getSettings()
    expect(st.pauseUntil).toBe(NOW.getTime() + 7 * 86_400_000)
    expect(st.pauseIndefinite).toBe(false)
    expect(st.pauseStartedAt).toBe(NOW.getTime())
    expect(st.enabled).toBe(true)
    expect(st.seededMailboxes).toEqual(['a@x.com'])
    expect(sent[1]!.text).toBe('Email alerts paused until Sun 11:00 am.')
  })

  it('Until I turn it back on sets pauseIndefinite', async () => {
    makeAlert()
    await b.handleAlertClick('c1', '50', 'Pause alerts', io())
    await b.handleAlertClick('c1', '100', 'Until I turn it back on', io())
    const st = s.getSettings()
    expect(st.pauseIndefinite).toBe(true)
    expect(st.pauseUntil).toBeNull()
    expect(sent[1]!.text).toBe('Email alerts paused until you turn them back on.')
  })

  it('formats same-day and tomorrow times in the box timezone', () => {
    expect(b.pauseFor('1h', NOW, 'America/Toronto')).toBe('Email alerts paused until 12:00 pm.')
    expect(b.pauseFor('tomorrow', NOW, 'America/Toronto')).toBe('Email alerts paused until 7:00 am tomorrow.')
  })

  it('matches a click after restart', async () => {
    makeAlert()
    dbm.getDb().close()
    expect(await b.handleAlertClick('c1', '50', 'Useful', io())).toBe(true)
    expect(s.findAlertByChatMessage('c1', '50')?.feedback).toBe('useful')
  })

  it('a pause survives a restart', () => {
    b.pauseFor('1w', NOW, 'America/Toronto')
    dbm.getDb().close()
    const st = s.getSettings()
    expect(st.pauseUntil).toBe(NOW.getTime() + 7 * 86_400_000)
    expect(st.pauseIndefinite).toBe(false)
  })

  it('non-alert message returns false', async () => {
    expect(await b.handleAlertClick('c1', '999', 'Useful', io())).toBe(false)
    expect(sent).toEqual([])
  })
})
