/**
 * Session persistence for the AI SDK runtime.
 *
 * The claude runtime gets session resumption free from Claude Code session
 * files; this runtime owns its history in SQLite instead. One row per
 * conversation: the full ModelMessage[] as JSON. Session ids are stable
 * across turns (callers pass the same id back), unlike Claude Code which
 * mints a new id per turn — both satisfy the AgentRuntime contract because
 * callers always store whatever newSessionId comes back.
 */
import { randomUUID } from 'node:crypto'
import type DatabaseType from 'better-sqlite3'
import type { ModelMessage } from 'ai'
import { getDb } from '../../db.js'

export class SessionStore {
  private db: DatabaseType.Database | null
  private initialized = false

  constructor(db?: DatabaseType.Database) {
    // Lazy: don't open the store until first use, so constructing a runtime
    // (e.g. the factory registering 'ai-sdk') never touches the filesystem.
    this.db = db ?? null
  }

  private init(): DatabaseType.Database {
    if (!this.db) this.db = getDb()
    if (!this.initialized) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_sdk_sessions (
          id TEXT PRIMARY KEY,
          messages TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      // Migration: track which provider wrote the session, so a provider
      // switch can sanitize the replayed history (provider-specific
      // options/reasoning signatures break other vendors' APIs). exec-only
      // (no .pragma) so injected test doubles keep working.
      try {
        this.db.exec('ALTER TABLE ai_sdk_sessions ADD COLUMN provider TEXT')
      } catch {
        /* column already exists */
      }
      this.initialized = true
    }
    return this.db
  }

  newSessionId(): string {
    return randomUUID()
  }

  load(sessionId: string): ModelMessage[] | null {
    const row = this.init()
      .prepare('SELECT messages FROM ai_sdk_sessions WHERE id = ?')
      .get(sessionId) as { messages: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.messages) as ModelMessage[]
    } catch {
      return null
    }
  }

  save(sessionId: string, messages: ModelMessage[], provider?: string): void {
    this.init()
      .prepare(`
        INSERT INTO ai_sdk_sessions (id, messages, updated_at, provider)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at, provider = excluded.provider
      `)
      .run(sessionId, JSON.stringify(messages), Date.now(), provider ?? null)
  }

  /** Provider that last wrote this session, or null for unknown/legacy rows. */
  loadProvider(sessionId: string): string | null {
    const row = this.init()
      .prepare('SELECT provider FROM ai_sdk_sessions WHERE id = ?')
      .get(sessionId) as { provider: string | null } | undefined
    return row?.provider ?? null
  }
}
