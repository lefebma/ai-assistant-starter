/** The anonymizer's table (card #187). Kept apart from store.ts so db.ts can import it without a cycle. */
import type Database from 'better-sqlite3'

export function initPrivacyTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS privacy_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'owner',
      created_at INTEGER NOT NULL
    )
  `)
}
