/** Database access for web conversations and their messages. Every read is scoped to a chat. */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

export interface ConversationRow {
  id: string
  projectId: string
  title: string
  model: string
  effort: string
  sessionId: string | null
  createdAt: number
  updatedAt: number
}

export interface StoredFile {
  path: string
  name: string
  kind: 'photo' | 'document'
}

export interface MessageRow {
  id: number
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  files: StoredFile[]
  buttons: string[]
  createdAt: number
}

interface RawConv {
  id: string
  project_id: string
  title: string
  model: string
  effort: string
  session_id: string | null
  created_at: number
  updated_at: number
}

const toConv = (r: RawConv): ConversationRow => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  model: r.model,
  effort: r.effort,
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function createConversation(chatId: string, projectId: string, now: number = Date.now()): ConversationRow {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO web_conversations (id, chat_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, chatId, projectId, now, now)
  return getConversation(chatId, id)!
}

/** Null for an unknown id and for another chat's id alike. */
export function getConversation(chatId: string, id: string): ConversationRow | null {
  const r = getDb().prepare('SELECT * FROM web_conversations WHERE id = ? AND chat_id = ?').get(id, chatId) as RawConv | undefined
  return r ? toConv(r) : null
}

export function listConversations(chatId: string, projectId?: string): ConversationRow[] {
  const rows = (
    projectId === undefined
      ? getDb().prepare('SELECT * FROM web_conversations WHERE chat_id = ? ORDER BY updated_at DESC, created_at DESC').all(chatId)
      : getDb()
          .prepare('SELECT * FROM web_conversations WHERE chat_id = ? AND project_id = ? ORDER BY updated_at DESC, created_at DESC')
          .all(chatId, projectId)
  ) as RawConv[]
  return rows.map(toConv)
}

export function updateConversation(
  chatId: string,
  id: string,
  patch: { title?: string; model?: string; effort?: string; sessionId?: string },
  now: number = Date.now(),
): boolean {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.title !== undefined) (sets.push('title = ?'), vals.push(patch.title))
  if (patch.model !== undefined) (sets.push('model = ?'), vals.push(patch.model))
  if (patch.effort !== undefined) (sets.push('effort = ?'), vals.push(patch.effort))
  if (patch.sessionId !== undefined) (sets.push('session_id = ?'), vals.push(patch.sessionId))
  sets.push('updated_at = ?')
  vals.push(now)
  const r = getDb()
    .prepare(`UPDATE web_conversations SET ${sets.join(', ')} WHERE id = ? AND chat_id = ?`)
    .run(...vals, id, chatId)
  return r.changes > 0
}

export function deleteConversation(chatId: string, id: string): boolean {
  const db = getDb()
  return db.transaction(() => {
    if (!getConversation(chatId, id)) return false
    db.prepare('DELETE FROM web_messages WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM web_conversations WHERE id = ? AND chat_id = ?').run(id, chatId)
    return true
  })()
}

export function addMessage(
  convId: string,
  role: 'user' | 'assistant',
  content: string,
  files: StoredFile[] = [],
  buttons: string[] = [],
  now: number = Date.now(),
): number {
  const r = getDb()
    .prepare('INSERT INTO web_messages (conversation_id, role, content, files, buttons, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(convId, role, content, JSON.stringify(files), JSON.stringify(buttons), now)
  getDb().prepare('UPDATE web_conversations SET updated_at = ? WHERE id = ?').run(now, convId)
  return Number(r.lastInsertRowid)
}

function parseArr<T>(s: string): T[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

interface RawMsg {
  id: number
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  files: string
  buttons: string
  created_at: number
}

const toMsg = (r: RawMsg): MessageRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  files: parseArr<StoredFile>(r.files),
  buttons: parseArr<string>(r.buttons),
  createdAt: r.created_at,
})

export function listMessages(convId: string): MessageRow[] {
  return (getDb().prepare('SELECT * FROM web_messages WHERE conversation_id = ? ORDER BY id').all(convId) as RawMsg[]).map(toMsg)
}

/** A message, only if its conversation belongs to this chat. */
export function getMessageForChat(chatId: string, messageId: number): MessageRow | null {
  const r = getDb()
    .prepare(
      'SELECT m.* FROM web_messages m JOIN web_conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.chat_id = ?',
    )
    .get(messageId, chatId) as RawMsg | undefined
  return r ? toMsg(r) : null
}
