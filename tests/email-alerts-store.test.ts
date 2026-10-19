import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-email-alerts-'))
process.env['AGENT_STORE_DIR'] = STORE

type Store = typeof import('../src/email-alerts/store.js')
type Db = typeof import('../src/db.js')
let s: Store
let dbm: Db

const base = {
  mailbox: 'a@x.com',
  msgId: 'm1',
  sender: 'boss@x.com',
  subject: 'Server down',
  reason: 'outage',
  vip: false,
  status: 'held' as const,
  createdAt: 1000,
}

beforeAll(async () => {
  dbm = await import('../src/db.js')
  dbm.initDatabase()
  s = await import('../src/email-alerts/store.js')
})

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
  d.exec(`DELETE FROM app_state WHERE key = 'email_alerts.settings'`)
})

afterAll(() => {
  try {
    dbm.getDb().close()
  } catch {
    // no handle
  }
  rmSync(STORE, { recursive: true, force: true })
})

describe('email alerts store', () => {
  it('markSeen returns false the second time and for the same Message-ID in another mailbox', () => {
    expect(s.markSeen('a@x.com', 'm1', '<rfc1@x>')).toBe(true)
    expect(s.markSeen('a@x.com', 'm1', '<rfc1@x>')).toBe(false)
    expect(s.markSeen('b@x.com', 'other', '<rfc1@x>')).toBe(false)
    expect(s.markSeen('b@x.com', 'n1', null)).toBe(true)
    expect(s.markSeen('b@x.com', 'n2', null)).toBe(true)
  })

  it('recordAction allows Useful then Mute but not Useful twice', () => {
    const id = s.insertAlert(base)
    expect(s.recordAction(id, 'useful')).toBe(true)
    expect(s.recordAction(id, 'mute')).toBe(true)
    expect(s.recordAction(id, 'useful')).toBe(false)
    s.markAlertSent(id, 'c1', 'p1', 2000)
    expect(s.findAlertByChatMessage('c1', 'p1')?.actions).toEqual(['useful', 'mute'])
  })

  it('findAlertByChatMessage survives reopening the DB', () => {
    const id = s.insertAlert(base)
    s.markAlertSent(id, 'c1', 'p1', 2000)
    dbm.getDb().pragma('wal_checkpoint(TRUNCATE)')
    dbm.getDb().close()
    const found = s.findAlertByChatMessage('c1', 'p1')
    expect(found?.id).toBe(id)
    expect(found?.status).toBe('sent')
    expect(found?.vip).toBe(false)
    expect(found?.sentAt).toBe(2000)
  })

  it('stats counts only sent alerts since the cutoff', () => {
    const old = s.insertAlert({ ...base, msgId: 'old' })
    s.markAlertSent(old, 'c', '1', 500)
    const a = s.insertAlert({ ...base, msgId: 'a' })
    s.markAlertSent(a, 'c', '2', 5000)
    s.setFeedback(a, 'useful')
    const b = s.insertAlert({ ...base, msgId: 'b' })
    s.markAlertSent(b, 'c', '3', 6000)
    s.setFeedback(b, 'not_urgent')
    s.insertAlert({ ...base, msgId: 'held' })
    expect(s.stats(1000)).toEqual({ sent: 2, useful: 1, notUrgent: 1 })
    expect(s.alertsByStatus('held')).toHaveLength(1)
  })

  it('getSettings returns defaults when unset', () => {
    const d = s.getSettings()
    expect(d.enabled).toBe(false)
    expect(d.quietStart).toBe('22:00')
    expect(d.quietEnd).toBe('07:00')
    expect(d.seededMailboxes).toEqual([])
    s.saveSettings({ ...d, enabled: true })
    expect(s.getSettings().enabled).toBe(true)
  })

  it('list entries are stored lowercase and deduped', () => {
    s.listAdd('vip', 'Boss@X.com')
    s.listAdd('vip', 'boss@x.com')
    expect(s.listAll('vip')).toEqual(['boss@x.com'])
    expect(s.listAll('mute')).toEqual([])
    expect(s.listRemove('vip', 'BOSS@x.com')).toBe(true)
    expect(s.listRemove('vip', 'boss@x.com')).toBe(false)
  })

  it('menus and triage counts round-trip', () => {
    s.registerMenu('c', 'p', 'pause', 7)
    expect(s.findMenu('c', 'p')).toEqual({ kind: 'pause', alertId: 7 })
    expect(s.findMenu('c', 'zz')).toBeNull()
    expect(s.bumpTriageCount('2026-10-18')).toBe(1)
    expect(s.bumpTriageCount('2026-10-18')).toBe(2)
    expect(s.triageCount('2026-10-19')).toBe(0)
  })
})
