/**
 * Conversation references for proactive sends, and a dedupe table for
 * inbound activity ids. Teams activity ids are strings, so they cannot share
 * the integer-keyed processed_updates table Telegram uses.
 */
import { getDb } from '../../db.js'
import type { ConversationReference } from './types.js'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

export function initTeamsTables(): void {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS teams_conversations (
      conversation_id TEXT PRIMARY KEY,
      service_url TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tenant_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE IF NOT EXISTS teams_processed_activities (
      activity_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE IF NOT EXISTS teams_pending_uploads (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
}

export function upsertConversation(ref: ConversationReference): void {
  getDb()
    .prepare(
      `INSERT INTO teams_conversations (conversation_id, service_url, bot_id, user_id, tenant_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         service_url = excluded.service_url,
         bot_id = excluded.bot_id,
         user_id = excluded.user_id,
         tenant_id = excluded.tenant_id,
         updated_at = excluded.updated_at`
    )
    .run(ref.conversationId, ref.serviceUrl, ref.botId, ref.userId, ref.tenantId ?? null, now())
}

export function getConversation(conversationId: string): ConversationReference | null {
  const row = getDb()
    .prepare('SELECT conversation_id, service_url, bot_id, user_id, tenant_id FROM teams_conversations WHERE conversation_id = ?')
    .get(conversationId) as
    | { conversation_id: string; service_url: string; bot_id: string; user_id: string; tenant_id: string | null }
    | undefined
  if (!row) return null
  const ref: ConversationReference = {
    conversationId: row.conversation_id,
    serviceUrl: row.service_url,
    botId: row.bot_id,
    userId: row.user_id,
  }
  if (row.tenant_id) ref.tenantId = row.tenant_id
  return ref
}

export function hasProcessedActivity(activityId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM teams_processed_activities WHERE activity_id = ?').get(activityId)
}

export function markActivityProcessed(activityId: string): void {
  const d = getDb()
  d.prepare('INSERT OR IGNORE INTO teams_processed_activities (activity_id, processed_at) VALUES (?, ?)').run(activityId, now())
  d.prepare('DELETE FROM teams_processed_activities WHERE processed_at < ?').run(now() - 7 * 86400)
}

/**
 * A file the owner has been offered but has not yet accepted or declined.
 *
 * This started as a Map on the adapter, which meant every restart silently
 * dropped every outstanding offer: the card stayed on screen, and clicking
 * Allow after an update or a reboot got "that file is no longer waiting to be
 * sent". A box restarts for every update, and a consent card is exactly the
 * kind of thing that sits unanswered overnight, so the two collide often
 * enough to matter.
 *
 * Only the path is kept, never the bytes. The file is already on disk and may
 * be large; a row that outlives the file it names is handled at upload time,
 * where the read fails and the owner is told.
 */
export interface PendingUpload {
  id: string
  chatId: string
  filePath: string
  name: string
  sizeInBytes: number
  /** Unix seconds. Supplied by the caller so the adapter's clock stays the one source of time. */
  createdAt: number
}

export function savePendingUpload(entry: PendingUpload): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO teams_pending_uploads (id, chat_id, file_path, name, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entry.id, entry.chatId, entry.filePath, entry.name, entry.sizeInBytes, entry.createdAt)
}

/**
 * Claim an offer: returns it and removes it in one statement, so a card
 * clicked twice cannot produce two uploads to a single-use URL.
 *
 * The chat has to match. The invoke is signed by the Bot Framework, so this
 * is not the likeliest attack, but an offer made in one conversation has no
 * business being redeemed from another, and the check costs a WHERE clause.
 * A mismatch leaves the row in place rather than consuming it.
 */
export function takePendingUpload(id: string, chatId: string, notOlderThan: number): PendingUpload | null {
  const row = getDb()
    .prepare(
      `DELETE FROM teams_pending_uploads
       WHERE id = ? AND chat_id = ? AND created_at >= ?
       RETURNING id, chat_id, file_path, name, size_bytes, created_at`
    )
    .get(id, chatId, notOlderThan) as
    | { id: string; chat_id: string; file_path: string; name: string; size_bytes: number; created_at: number }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    chatId: row.chat_id,
    filePath: row.file_path,
    name: row.name,
    sizeInBytes: row.size_bytes,
    createdAt: row.created_at,
  }
}

/** Drop what has expired, then the oldest of whatever is still over the cap. */
export function prunePendingUploads(olderThan: number, keep: number): void {
  const d = getDb()
  d.prepare('DELETE FROM teams_pending_uploads WHERE created_at < ?').run(olderThan)
  d.prepare(
    `DELETE FROM teams_pending_uploads WHERE id IN (
       SELECT id FROM teams_pending_uploads ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
     )`
  ).run(keep)
}

/** Test and diagnostic use: how many offers are outstanding. */
export function countPendingUploads(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM teams_pending_uploads').get() as { n: number }).n
}
