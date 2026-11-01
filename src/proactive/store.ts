import type Database from 'better-sqlite3'
import { getDb } from '../db.js'

/**
 * One row per meeting and kind of message, decided once. `quiet` rows record
 * a decision to say nothing, so the owner (or support) can see why a meeting
 * got no message. `pending` is a message decided but not yet accepted by the
 * chat; `failed` gave up after MAX_SEND_ATTEMPTS or once the meeting started.
 */
export type Kind = 'briefing' | 'travel' | 'timing'
export type DecisionStatus = 'quiet' | 'pending' | 'sent' | 'failed'

export const MAX_SEND_ATTEMPTS = 3
/** Decisions older than this are pruned; the log only needs recent history. */
export const KEEP_MS = 30 * 86_400_000

export interface DecisionRow {
  id: number
  eventKey: string
  seriesKey: string
  kind: Kind
  title: string
  startMs: number
  status: DecisionStatus
  reason: string
  text: string
  attempts: number
  createdAt: number
  sentAt: number | null
  chatId: string | null
  chatMessageId: string | null
  /** What the message was about, for a reply or a follow-up button (card #263). JSON, '' for none. */
  context: string
}

export function initProactiveTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      series_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      chat_id TEXT,
      chat_message_id TEXT,
      UNIQUE (event_key, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_decisions_status ON proactive_decisions(status, start_ms);
    CREATE TABLE IF NOT EXISTS proactive_covered (
      series_key TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      covered_at INTEGER NOT NULL,
      PRIMARY KEY (series_key, msg_id)
    );
    CREATE TABLE IF NOT EXISTS proactive_trips (
      event_key TEXT PRIMARY KEY,
      trip TEXT NOT NULL,
      computed_at INTEGER NOT NULL,
      refreshed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS proactive_seen (
      event_id TEXT NOT NULL,
      decision_id INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      location TEXT NOT NULL,
      PRIMARY KEY (event_id, decision_id)
    );
    CREATE TABLE IF NOT EXISTS proactive_calls (
      day TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
  `)
  const cols = db.prepare('PRAGMA table_info(proactive_decisions)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'context')) db.exec("ALTER TABLE proactive_decisions ADD COLUMN context TEXT NOT NULL DEFAULT ''")
  db.exec('CREATE INDEX IF NOT EXISTS idx_proactive_decisions_chat ON proactive_decisions(chat_id, chat_message_id)')
}

interface RawRow {
  id: number
  event_key: string
  series_key: string
  kind: string
  title: string
  start_ms: number
  status: string
  reason: string
  text: string
  attempts: number
  created_at: number
  sent_at: number | null
  chat_id: string | null
  chat_message_id: string | null
  context: string | null
}

function toRow(r: RawRow): DecisionRow {
  return {
    id: r.id,
    eventKey: r.event_key,
    seriesKey: r.series_key,
    kind: r.kind as Kind,
    title: r.title,
    startMs: r.start_ms,
    status: r.status as DecisionStatus,
    reason: r.reason,
    text: r.text,
    attempts: r.attempts,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    chatId: r.chat_id,
    chatMessageId: r.chat_message_id,
    context: r.context ?? '',
  }
}

export function isDecided(eventKey: string, kind: Kind): boolean {
  return !!getDb().prepare('SELECT 1 FROM proactive_decisions WHERE event_key = ? AND kind = ?').get(eventKey, kind)
}

export function getDecision(eventKey: string, kind: Kind): DecisionRow | null {
  const r = getDb().prepare('SELECT * FROM proactive_decisions WHERE event_key = ? AND kind = ?').get(eventKey, kind) as RawRow | undefined
  return r ? toRow(r) : null
}

/** Records a decision. False when one already exists for this meeting and kind (another tick got there first). */
export function recordDecision(row: {
  eventKey: string
  seriesKey: string
  kind: Kind
  title: string
  startMs: number
  status: 'quiet' | 'pending'
  reason: string
  text: string
  createdAt: number
  context?: string
}): number | null {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO proactive_decisions
        (event_key, series_key, kind, title, start_ms, status, reason, text, created_at, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.eventKey, row.seriesKey, row.kind, row.title, row.startMs, row.status, row.reason, row.text, row.createdAt, row.context ?? '')
  return res.changes > 0 ? Number(res.lastInsertRowid) : null
}

export function pendingDecisions(): DecisionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM proactive_decisions WHERE status = 'pending' ORDER BY start_ms, id`)
    .all() as RawRow[]
  return rows.map(toRow)
}

export function markSent(id: number, chatId: string, chatMessageId: string, at: number): void {
  getDb()
    .prepare(
      `UPDATE proactive_decisions SET status = 'sent', sent_at = ?, chat_id = ?, chat_message_id = ?, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`
    )
    .run(at, chatId, chatMessageId, id)
}

/** Counts a failed send. Gives up once attempts run out or `giveUp` is set (the meeting has started). */
export function recordSendFailure(id: number, giveUp = false): DecisionStatus {
  const db = getDb()
  db.prepare(`UPDATE proactive_decisions SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).run(id)
  const row = db.prepare('SELECT attempts, status FROM proactive_decisions WHERE id = ?').get(id) as
    | { attempts: number; status: string }
    | undefined
  if (!row) return 'failed'
  if (row.status === 'pending' && (giveUp || row.attempts >= MAX_SEND_ATTEMPTS)) {
    db.prepare(`UPDATE proactive_decisions SET status = 'failed' WHERE id = ?`).run(id)
    return 'failed'
  }
  return row.status as DecisionStatus
}

/** A pending message quiet hours held past its use: kept in the log as quiet, with the reason. */
export function dropPending(id: number, reason: string): void {
  getDb().prepare(`UPDATE proactive_decisions SET status = 'quiet', reason = ? WHERE id = ? AND status = 'pending'`).run(reason, id)
}

/** Pending rows whose meeting starts before `cutoffMs` are given up without a send. */
export function expirePending(cutoffMs: number): number {
  return getDb()
    .prepare(`UPDATE proactive_decisions SET status = 'failed' WHERE status = 'pending' AND start_ms <= ?`)
    .run(cutoffMs).changes
}

/** The decisions a chat message carried: one for a briefing or travel message, one per problem for timing warnings. */
export function decisionsForChatMessage(chatId: string, chatMessageId: string): DecisionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM proactive_decisions WHERE chat_id = ? AND chat_message_id = ? AND status = 'sent' ORDER BY id`)
    .all(chatId, chatMessageId) as RawRow[]
  return rows.map(toRow)
}

export function getDecisionById(id: number): DecisionRow | null {
  const r = getDb().prepare('SELECT * FROM proactive_decisions WHERE id = ?').get(id) as RawRow | undefined
  return r ? toRow(r) : null
}

/** Messages the chat accepted, newest first. */
export function recentSent(limit: number): DecisionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM proactive_decisions WHERE status = 'sent' ORDER BY sent_at DESC, id DESC LIMIT ?`)
    .all(limit) as RawRow[]
  return rows.map(toRow)
}

export function recentDecisions(limit: number): DecisionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM proactive_decisions ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as RawRow[]
  return rows.map(toRow)
}

export function prune(nowMs: number): void {
  const db = getDb()
  db.prepare('DELETE FROM proactive_decisions WHERE start_ms < ?').run(nowMs - KEEP_MS)
  db.prepare('DELETE FROM proactive_covered WHERE covered_at < ?').run(nowMs - 4 * KEEP_MS)
  db.prepare('DELETE FROM proactive_trips WHERE computed_at < ?').run(nowMs - 2 * 86_400_000)
  db.prepare('DELETE FROM proactive_seen WHERE decision_id NOT IN (SELECT id FROM proactive_decisions)').run()
}

/**
 * What a meeting looked like when a message about it was decided (card
 * #261), so a later move or new place can be pointed out. Kept per message:
 * only messages the chat accepted count as seen by the owner.
 */
export interface Seen {
  startMs: number
  location: string
}

export function recordSeen(eventId: string, decisionId: number, startMs: number, location: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO proactive_seen (event_id, decision_id, start_ms, location) VALUES (?, ?, ?, ?)')
    .run(eventId, decisionId, startMs, location)
}

/** How the meeting looked in the newest message about it that was sent; null when none was. */
export function lastSeen(eventId: string): Seen | null {
  const row = getDb()
    .prepare(
      `SELECT s.start_ms, s.location FROM proactive_seen s JOIN proactive_decisions d ON d.id = s.decision_id
       WHERE s.event_id = ? AND d.status = 'sent' ORDER BY d.sent_at DESC, d.id DESC LIMIT 1`
    )
    .get(eventId) as { start_ms: number; location: string } | undefined
  return row ? { startMs: row.start_ms, location: row.location } : null
}

/**
 * A meeting's planned trip (card #260), kept so the route is looked up once
 * when the meeting comes into view and once more for traffic, not every
 * tick. The trip holds the travel time and where it starts, never more than
 * the decision row's own title; the meeting's key changes when it moves.
 */
export interface StoredTrip<T> {
  trip: T
  computedAt: number
  refreshed: boolean
}

export function getTrip<T>(eventKey: string): StoredTrip<T> | null {
  const row = getDb().prepare('SELECT trip, computed_at, refreshed FROM proactive_trips WHERE event_key = ?').get(eventKey) as
    | { trip: string; computed_at: number; refreshed: number }
    | undefined
  if (!row) return null
  try {
    return { trip: JSON.parse(row.trip) as T, computedAt: row.computed_at, refreshed: row.refreshed === 1 }
  } catch {
    return null
  }
}

export function saveTrip(eventKey: string, trip: unknown, at: number, refreshed: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO proactive_trips (event_key, trip, computed_at, refreshed) VALUES (?, ?, ?, ?)
       ON CONFLICT(event_key) DO UPDATE SET trip = excluded.trip, computed_at = excluded.computed_at, refreshed = excluded.refreshed`
    )
    .run(eventKey, JSON.stringify(trip), at, refreshed ? 1 : 0)
}

/** Message ids a recurring meeting's earlier briefing already covered. */
export function coveredIds(seriesKey: string): Set<string> {
  const rows = getDb().prepare('SELECT msg_id FROM proactive_covered WHERE series_key = ?').all(seriesKey) as {
    msg_id: string
  }[]
  return new Set(rows.map((r) => r.msg_id))
}

export function markCovered(seriesKey: string, ids: string[], at: number): void {
  const stmt = getDb().prepare('INSERT OR IGNORE INTO proactive_covered (series_key, msg_id, covered_at) VALUES (?, ?, ?)')
  const tx = getDb().transaction((list: string[]) => {
    for (const id of list) stmt.run(seriesKey, id, at)
  })
  tx(ids)
}

export function callCount(day: string): number {
  const row = getDb().prepare('SELECT count FROM proactive_calls WHERE day = ?').get(day) as { count: number } | undefined
  return row?.count ?? 0
}

export function bumpCallCount(day: string): void {
  getDb()
    .prepare('INSERT INTO proactive_calls (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1')
    .run(day)
  getDb().prepare('DELETE FROM proactive_calls WHERE day < ?').run(day.slice(0, 8) + '00')
}
