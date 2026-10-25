/**
 * Obligation state on disk (card #234, from spike #217 defect 5).
 *
 * createRun keeps its state in memory, so a restart used to lose every piece
 * of evidence the first boot had seen and the run read as incomplete forever.
 * openRun is the same checker with each change written to SQLite: reopening
 * a run id after a restart restores its obligations, its evidence and any
 * terminal status, so a resumed run carries on from what it already proved.
 *
 * The run id is the effect journal's run key (`job:<id>`, `job:<id>@<due>`,
 * `card:...`), so a scheduled run and its effects line up under one name.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { createRun, type AuthorityFacet, type ModelFacet, type Obligation, type RunState, type RunStatus } from './obligations.js'

let ready: Database.Database | null = null

export function initRunStateTables(d: Database.Database = getDb()): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  ready = d
}

function db(): Database.Database {
  const d = getDb()
  if (ready !== d) initRunStateTables(d)
  return d
}

const now = () => Math.floor(Date.now() / 1000)

function save(s: RunState): void {
  const t = now()
  db().prepare(
    `INSERT INTO run_state (run_id, state, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET state = excluded.state, status = excluded.status, updated_at = excluded.updated_at`
  ).run(s.runId, JSON.stringify(s), s.terminal?.status ?? null, t, t)
}

/** The saved state of a run, or undefined when nothing was ever opened under that id. */
export function loadRunState(runId: string): RunState | undefined {
  const row = db().prepare('SELECT state FROM run_state WHERE run_id = ?').get(runId) as { state: string } | undefined
  return row ? (JSON.parse(row.state) as RunState) : undefined
}

/**
 * Open a run, or reopen it after a restart. A saved run keeps its own
 * obligations and `initial` is ignored; change scope with `authority.amend`.
 */
export function openRun(runId: string, initial: Obligation[]): { authority: AuthorityFacet; model: ModelFacet; restored: boolean } {
  const state = loadRunState(runId)
  const run = createRun(runId, initial, { state, onChange: save })
  if (!state) save({ runId, version: 1, obligations: initial.map(o => ({ ...o })), satisfied: {}, seen: [], terminal: null })
  return { ...run, restored: Boolean(state) }
}

/**
 * Close a saved run as unknown: the orphan sweep uses this for a run that
 * died mid-way and will not be resumed. No-op when the run has no saved state
 * or is already closed. Returns the status the run now has.
 */
export function markRunUnknown(runId: string, reason: string): RunStatus | null {
  const state = loadRunState(runId)
  if (!state) return null
  const { authority } = createRun(runId, state.obligations, { state, onChange: save })
  authority.markUnknown(reason)
  return authority.requestCompletion().status
}
