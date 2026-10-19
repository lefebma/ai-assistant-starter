import type Database from 'better-sqlite3'
import { getDb, getAppState, setAppState } from '../db.js'

/** `held`: waiting for quiet hours to end. `retry`: a send failed and will be tried again. */
export type AlertStatus = 'sent' | 'held' | 'paused' | 'suppressed' | 'retry'

/** Sends per alert, the first included, before it is given up as `suppressed`. */
export const MAX_SEND_ATTEMPTS = 3
/** `pause`: the how-long menu. `undo_mute`: the Undo mute button after muting a sender. */
export type MenuKind = 'pause' | 'undo_mute'
export type Feedback = 'useful' | 'not_urgent' | null

export interface AlertRow {
  id: number
  mailbox: string
  msgId: string
  sender: string
  subject: string
  reason: string
  vip: boolean
  status: AlertStatus
  createdAt: number
  sentAt: number | null
  chatId: string | null
  chatMessageId: string | null
  feedback: Feedback
  actions: string[]
  attempts: number
}

export interface AlertSettings {
  enabled: boolean
  pauseUntil: number | null
  pauseIndefinite: boolean
  pauseStartedAt: number | null
  quietStart: string
  quietEnd: string
  seededMailboxes: string[]
  /** A pause ended during quiet hours; its summary goes out when they end. */
  pauseSummaryPending: boolean
}

const SETTINGS_KEY = 'email_alerts.settings'

export function initEmailAlertTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_alert_seen (
      mailbox TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      rfc_message_id TEXT,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (mailbox, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_email_alert_seen_rfc ON email_alert_seen(rfc_message_id);
    CREATE TABLE IF NOT EXISTS email_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      subject TEXT NOT NULL,
      reason TEXT NOT NULL,
      vip INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      chat_id TEXT,
      chat_message_id TEXT,
      feedback TEXT,
      actions TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_alerts_status ON email_alerts(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_alerts_chat ON email_alerts(chat_id, chat_message_id);
    CREATE TABLE IF NOT EXISTS email_alert_lists (
      kind TEXT NOT NULL,
      entry TEXT NOT NULL,
      PRIMARY KEY (kind, entry)
    );
    CREATE TABLE IF NOT EXISTS email_alert_menus (
      chat_id TEXT NOT NULL,
      chat_message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      alert_id INTEGER,
      PRIMARY KEY (chat_id, chat_message_id)
    );
    CREATE TABLE IF NOT EXISTS email_alert_triage_counts (
      day TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );
  `)
  const cols = db.prepare('PRAGMA table_info(email_alerts)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'attempts')) {
    db.exec('ALTER TABLE email_alerts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
  }
}

/** Records the email as seen. Returns false if it was already seen (same id or same RFC Message-ID). */
export function markSeen(mailbox: string, msgId: string, rfcMessageId: string | null): boolean {
  const db = getDb()
  const dupe = db
    .prepare(
      `SELECT 1 FROM email_alert_seen
       WHERE (mailbox = ? AND msg_id = ?) OR (? IS NOT NULL AND rfc_message_id = ?) LIMIT 1`
    )
    .get(mailbox, msgId, rfcMessageId, rfcMessageId)
  if (dupe) return false
  db.prepare(
    'INSERT INTO email_alert_seen (mailbox, msg_id, rfc_message_id, seen_at) VALUES (?, ?, ?, ?)'
  ).run(mailbox, msgId, rfcMessageId, Date.now())
  return true
}

interface RawAlert {
  id: number
  mailbox: string
  msg_id: string
  sender: string
  subject: string
  reason: string
  vip: number
  status: AlertStatus
  created_at: number
  sent_at: number | null
  chat_id: string | null
  chat_message_id: string | null
  feedback: Feedback
  actions: string
  attempts: number
}

function toRow(r: RawAlert): AlertRow {
  return {
    id: r.id,
    mailbox: r.mailbox,
    msgId: r.msg_id,
    sender: r.sender,
    subject: r.subject,
    reason: r.reason,
    vip: r.vip === 1,
    status: r.status,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    chatId: r.chat_id,
    chatMessageId: r.chat_message_id,
    feedback: r.feedback,
    actions: JSON.parse(r.actions) as string[],
    attempts: r.attempts,
  }
}

export function insertAlert(
  a: Omit<AlertRow, 'id' | 'sentAt' | 'chatId' | 'chatMessageId' | 'feedback' | 'actions' | 'attempts'>
): number {
  const res = getDb()
    .prepare(
      `INSERT INTO email_alerts (mailbox, msg_id, sender, subject, reason, vip, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(a.mailbox, a.msgId, a.sender, a.subject, a.reason, a.vip ? 1 : 0, a.status, a.createdAt)
  return Number(res.lastInsertRowid)
}

export function markAlertSent(id: number, chatId: string, chatMessageId: string, at: number): void {
  getDb()
    .prepare(
      `UPDATE email_alerts SET status = 'sent', sent_at = ?, chat_id = ?, chat_message_id = ? WHERE id = ?`
    )
    .run(at, chatId, chatMessageId, id)
}

/** Recorded as sent without its own message (it was counted in an overflow line). */
export function markAlertSentQuiet(id: number, at: number): void {
  getDb().prepare(`UPDATE email_alerts SET status = 'sent', sent_at = ? WHERE id = ?`).run(at, id)
}

/**
 * Counts a failed send. Below MAX_SEND_ATTEMPTS the alert goes to `retry`;
 * at it, the alert is given up as `suppressed`. Returns the new status.
 */
export function recordSendFailure(id: number): AlertStatus {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare('SELECT attempts FROM email_alerts WHERE id = ?').get(id) as
      | { attempts: number }
      | undefined
    const attempts = (row?.attempts ?? 0) + 1
    const status: AlertStatus = attempts >= MAX_SEND_ATTEMPTS ? 'suppressed' : 'retry'
    db.prepare('UPDATE email_alerts SET attempts = ?, status = ? WHERE id = ?').run(attempts, status, id)
    return status
  })()
}

export function alertsByStatus(status: AlertStatus): AlertRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM email_alerts WHERE status = ? ORDER BY created_at DESC, id DESC')
    .all(status) as RawAlert[]
  return rows.map(toRow)
}

export function findAlertByChatMessage(chatId: string, chatMessageId: string): AlertRow | null {
  const row = getDb()
    .prepare('SELECT * FROM email_alerts WHERE chat_id = ? AND chat_message_id = ?')
    .get(chatId, chatMessageId) as RawAlert | undefined
  return row ? toRow(row) : null
}

export function findAlertById(id: number): AlertRow | null {
  const row = getDb().prepare('SELECT * FROM email_alerts WHERE id = ?').get(id) as RawAlert | undefined
  return row ? toRow(row) : null
}

/** Returns false if this action was already taken on this alert. */
export function recordAction(id: number, action: string): boolean {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare('SELECT actions FROM email_alerts WHERE id = ?').get(id) as
      | { actions: string }
      | undefined
    if (!row) return false
    const actions = JSON.parse(row.actions) as string[]
    if (actions.includes(action)) return false
    actions.push(action)
    db.prepare('UPDATE email_alerts SET actions = ? WHERE id = ?').run(JSON.stringify(actions), id)
    return true
  })()
}

export function setFeedback(id: number, f: Exclude<Feedback, null>): void {
  getDb().prepare('UPDATE email_alerts SET feedback = ? WHERE id = ?').run(f, id)
}

export function stats(sinceMs: number): { sent: number; useful: number; notUrgent: number } {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS sent,
              COALESCE(SUM(feedback = 'useful'), 0) AS useful,
              COALESCE(SUM(feedback = 'not_urgent'), 0) AS notUrgent
       FROM email_alerts WHERE status = 'sent' AND sent_at >= ?`
    )
    .get(sinceMs) as { sent: number; useful: number; notUrgent: number }
  return { sent: r.sent, useful: r.useful, notUrgent: r.notUrgent }
}

export function listAdd(kind: 'vip' | 'mute', entry: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO email_alert_lists (kind, entry) VALUES (?, ?)')
    .run(kind, entry.trim().toLowerCase())
}

export function listRemove(kind: 'vip' | 'mute', entry: string): boolean {
  const res = getDb()
    .prepare('DELETE FROM email_alert_lists WHERE kind = ? AND entry = ?')
    .run(kind, entry.trim().toLowerCase())
  return res.changes > 0
}

export function listAll(kind: 'vip' | 'mute'): string[] {
  const rows = getDb()
    .prepare('SELECT entry FROM email_alert_lists WHERE kind = ? ORDER BY entry')
    .all(kind) as { entry: string }[]
  return rows.map((r) => r.entry)
}

export function registerMenu(
  chatId: string,
  chatMessageId: string,
  kind: MenuKind,
  alertId: number | null
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO email_alert_menus (chat_id, chat_message_id, kind, alert_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(chatId, chatMessageId, kind, alertId)
}

export function findMenu(
  chatId: string,
  chatMessageId: string
): { kind: MenuKind; alertId: number | null } | null {
  const row = getDb()
    .prepare('SELECT kind, alert_id FROM email_alert_menus WHERE chat_id = ? AND chat_message_id = ?')
    .get(chatId, chatMessageId) as { kind: MenuKind; alert_id: number | null } | undefined
  return row ? { kind: row.kind, alertId: row.alert_id } : null
}

export function bumpTriageCount(localDay: string): number {
  const db = getDb()
  db.prepare(
    `INSERT INTO email_alert_triage_counts (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1`
  ).run(localDay)
  return triageCount(localDay)
}

export function triageCount(localDay: string): number {
  const row = getDb()
    .prepare('SELECT count FROM email_alert_triage_counts WHERE day = ?')
    .get(localDay) as { count: number } | undefined
  return row?.count ?? 0
}

function defaultSettings(): AlertSettings {
  return {
    enabled: false,
    pauseUntil: null,
    pauseIndefinite: false,
    pauseStartedAt: null,
    quietStart: '22:00',
    quietEnd: '07:00',
    seededMailboxes: [],
    pauseSummaryPending: false,
  }
}

export function getSettings(): AlertSettings {
  const raw = getAppState(SETTINGS_KEY)
  if (!raw) return defaultSettings()
  try {
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<AlertSettings>) }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(s: AlertSettings): void {
  setAppState(SETTINGS_KEY, JSON.stringify(s))
}
