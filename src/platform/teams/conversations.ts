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
