import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { STORE_DIR } from './config.js'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    db = new Database(resolve(STORE_DIR, 'assistant.db'))
    db.pragma('journal_mode = WAL')
  }
  return db
}

export function initDatabase(): void {
  const d = getDb()

  // Sessions table
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Full memory system
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid='id'
    )
  `)

  // FTS sync triggers
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      UPDATE memories_fts SET content = NEW.content WHERE rowid = NEW.id;
    END
  `)
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = OLD.id;
    END
  `)

  // Scheduled tasks
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next
    ON scheduled_tasks(status, next_run)
  `)

  // Authorized chats (multi-chat support)
  d.exec(`
    CREATE TABLE IF NOT EXISTS authorized_chats (
      chat_id TEXT PRIMARY KEY,
      label TEXT,
      authorized_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  // Processed Telegram updates (dedupe across restarts)
  d.exec(`
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id INTEGER PRIMARY KEY,
      processed_at INTEGER NOT NULL
    )
  `)

  // Migration: add columns for delivery mode, name, timezone
  const cols = d.pragma('table_info(scheduled_tasks)') as { name: string }[]
  const colNames = new Set(cols.map((c) => c.name))

  if (!colNames.has('name')) {
    d.exec('ALTER TABLE scheduled_tasks ADD COLUMN name TEXT')
  }
  if (!colNames.has('delivery_mode')) {
    d.exec("ALTER TABLE scheduled_tasks ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'announce'")
  }
  if (!colNames.has('timezone')) {
    d.exec("ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Toronto'")
  }
}

// --- Sessions ---

export function getSession(chatId: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as
    | { session_id: string }
    | undefined
  return row?.session_id ?? null
}

export function setSession(chatId: string, sessionId: string): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO sessions (chat_id, session_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET session_id = ?, updated_at = ?`
  ).run(chatId, sessionId, now(), sessionId, now())
}

export function clearSession(chatId: string): void {
  const d = getDb()
  d.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Memories ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
}

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const d = getDb()
  const ts = now()
  d.prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
     VALUES (?, ?, ?, ?, 1.0, ?, ?)`
  ).run(chatId, topicKey ?? null, content, sector, ts, ts)
}

export function searchMemories(query: string, limit = 3): Memory[] {
  const d = getDb()
  const sanitized = query.replace(/[^\w\s]/g, '').trim()
  if (!sanitized) return []
  const ftsQuery = sanitized
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w + '*')
    .join(' ')
  try {
    return d
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON f.rowid = m.id
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Memory[]
  } catch {
    return []
  }
}

export function getRecentMemories(chatId: string, limit = 5): Memory[] {
  const d = getDb()
  return d
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(chatId, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const d = getDb()
  d.prepare(
    `UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?`
  ).run(now(), id)
}

export function decayMemories(): void {
  const d = getDb()
  const oneDayAgo = now() - 86400
  d.prepare(`UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?`).run(oneDayAgo)
  d.prepare(`DELETE FROM memories WHERE salience < 0.1`).run()
}

export function getMemoriesForChat(chatId: string, limit = 20): Memory[] {
  const d = getDb()
  return d
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? ORDER BY salience DESC, accessed_at DESC LIMIT ?`
    )
    .all(chatId, limit) as Memory[]
}

export function clearMemories(chatId: string): void {
  const d = getDb()
  d.prepare('DELETE FROM memories WHERE chat_id = ?').run(chatId)
}

// --- Scheduled Tasks ---

export interface ScheduledTask {
  id: string
  chat_id: string
  name: string | null
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  delivery_mode: 'announce' | 'silent'
  timezone: string
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  name?: string,
  deliveryMode: 'announce' | 'silent' = 'announce',
  timezone = 'America/Toronto'
): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO scheduled_tasks (id, chat_id, name, prompt, schedule, next_run, delivery_mode, timezone, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(id, chatId, name ?? null, prompt, schedule, nextRun, deliveryMode, timezone, now())
}

export function getDueTasks(): ScheduledTask[] {
  const d = getDb()
  return d
    .prepare(`SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?`)
    .all(now()) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, result: string, nextRun: number): void {
  const d = getDb()
  d.prepare(
    `UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?`
  ).run(now(), result, nextRun, id)
}

export function getAllTasks(): ScheduledTask[] {
  const d = getDb()
  return d.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  const d = getDb()
  const result = d.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return result.changes > 0
}

export function pauseTask(id: string): boolean {
  const d = getDb()
  const result = d
    .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?")
    .run(id)
  return result.changes > 0
}

export function resumeTask(id: string, nextRun: number): boolean {
  const d = getDb()
  const result = d
    .prepare("UPDATE scheduled_tasks SET status = 'active', next_run = ? WHERE id = ?")
    .run(nextRun, id)
  return result.changes > 0
}

export function updateTaskPrompt(id: string, prompt: string): boolean {
  const d = getDb()
  const result = d
    .prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
    .run(prompt, id)
  return result.changes > 0
}

// --- Authorized Chats ---

export interface AuthorizedChat {
  chat_id: string
  label: string | null
  authorized_by: string
  created_at: number
}

export function addAuthorizedChat(chatId: string, label: string | null, authorizedBy: string): void {
  const d = getDb()
  d.prepare(
    `INSERT OR REPLACE INTO authorized_chats (chat_id, label, authorized_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(chatId, label, authorizedBy, now())
}

export function removeAuthorizedChat(chatId: string): boolean {
  const d = getDb()
  const result = d.prepare('DELETE FROM authorized_chats WHERE chat_id = ?').run(chatId)
  return result.changes > 0
}

export function getAuthorizedChats(): AuthorizedChat[] {
  const d = getDb()
  return d.prepare('SELECT * FROM authorized_chats ORDER BY created_at DESC').all() as AuthorizedChat[]
}

export function isAuthorizedChat(chatId: string): boolean {
  const d = getDb()
  const row = d.prepare('SELECT 1 FROM authorized_chats WHERE chat_id = ?').get(chatId)
  return !!row
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

// --- Processed updates (Telegram dedupe) ---

export function hasProcessedUpdate(updateId: number): boolean {
  const d = getDb()
  const row = d.prepare('SELECT 1 FROM processed_updates WHERE update_id = ?').get(updateId)
  return !!row
}

export function markUpdateProcessed(updateId: number): void {
  const d = getDb()
  d.prepare('INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)').run(
    updateId,
    now()
  )
  // Opportunistic cleanup: drop entries older than 7 days
  d.prepare('DELETE FROM processed_updates WHERE processed_at < ?').run(now() - 7 * 86400)
}
