/** The table of sites offered from chat (card #306). Apart from approvals.ts so db.ts can import it without a cycle. */
import type Database from 'better-sqlite3'

export function initEgressSiteTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS egress_sites (
      host TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      card TEXT,
      updated_at INTEGER NOT NULL
    )
  `)
}
