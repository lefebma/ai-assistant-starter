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
  // Names the finder noticed (card #275): offered once, answered once.
  d.exec(`
    CREATE TABLE IF NOT EXISTS privacy_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      lower TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      card TEXT,
      first_seen INTEGER NOT NULL,
      offered_at INTEGER
    )
  `)
}
