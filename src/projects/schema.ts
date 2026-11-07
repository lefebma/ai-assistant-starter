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
  // Where an imported project came from (`claude:<uuid>`, card #280). Unique per
  // chat, so a second upload or a double click cannot make a duplicate.
  const cols = (d.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes('source')) d.exec('ALTER TABLE projects ADD COLUMN source TEXT')
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_chat_source ON projects(chat_id, source) WHERE source IS NOT NULL')
}
