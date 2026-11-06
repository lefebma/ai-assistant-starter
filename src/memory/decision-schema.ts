/** The decision ledger's tables (card #235). Kept apart from decisions.ts so db.ts can import it without a cycle. */
import type Database from 'better-sqlite3'

export function initDecisionTables(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER,
      retired_reason TEXT
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_decisions_chat ON decisions(chat_id, retired_at, created_at)')
  // A decision the assistant proposed, waiting for the owner's tap on its card.
  d.exec(`
    CREATE TABLE IF NOT EXISTS decision_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      card_id TEXT,
      topic TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved TEXT
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_decision_proposals_card ON decision_proposals(chat_id, card_id)')
  // Where a Pin lands: the project the card came from, not the one open at the tap (card #281).
  const cols = d.pragma('table_info(decision_proposals)') as { name: string }[]
  if (!cols.some((c) => c.name === 'scope')) d.exec('ALTER TABLE decision_proposals ADD COLUMN scope TEXT')
}
