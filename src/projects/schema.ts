/** The projects table (card #281). Kept apart from store.ts so db.ts can import it without a cycle. */
import type Database from 'better-sqlite3'

export function initProjectTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_chat_name ON projects(chat_id, name COLLATE NOCASE)')
}
