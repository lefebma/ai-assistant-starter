/**
 * Per-install usage metering (Phase 4c plumbing).
 *
 * Records token usage per agent run into SQLite. The flat-subscription BYOK
 * launch doesn't bill on this — the customer pays their own model bill — but
 * the metering exists so (a) the customer can see what the assistant costs
 * them per provider/model, and (b) a future hosted tier has the data it
 * needs from day one. Token counts only, no prices: price tables rot, and
 * the provider's own console is the billing source of truth.
 *
 * Metering must never break a turn — use recordUsage(), which swallows
 * store failures and just logs.
 */
import type DatabaseType from 'better-sqlite3'
import { getDb } from './db.js'
import { logger } from './logger.js'

export interface UsageEntry {
  /** Epoch seconds. */
  ts: number
  runtime: string
  provider: string
  model: string
  sessionId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

export interface UsageSummaryRow {
  day: string
  provider: string
  model: string
  runs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

export class UsageMeter {
  private db: DatabaseType.Database | null
  private initialized = false

  constructor(db?: DatabaseType.Database) {
    this.db = db ?? null
  }

  private init(): DatabaseType.Database {
    if (!this.db) this.db = getDb()
    if (!this.initialized) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          runtime TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          session_id TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
      `)
      this.initialized = true
    }
    return this.db
  }

  record(entry: UsageEntry): void {
    this.init()
      .prepare(`
        INSERT INTO usage_log (ts, runtime, provider, model, session_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.ts,
        entry.runtime,
        entry.provider,
        entry.model,
        entry.sessionId ?? null,
        entry.inputTokens ?? 0,
        entry.outputTokens ?? 0,
        entry.totalTokens ?? 0,
        entry.cachedInputTokens ?? 0,
        entry.reasoningTokens ?? 0
      )
  }

  summary(opts: { sinceSecs?: number } = {}): UsageSummaryRow[] {
    return this.init()
      .prepare(`
        SELECT
          date(ts, 'unixepoch', 'localtime') AS day,
          provider,
          model,
          COUNT(*) AS runs,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(total_tokens) AS totalTokens,
          SUM(cached_input_tokens) AS cachedInputTokens,
          SUM(reasoning_tokens) AS reasoningTokens
        FROM usage_log
        WHERE ts >= ?
        GROUP BY day, provider, model
        ORDER BY day DESC, totalTokens DESC
      `)
      .all(opts.sinceSecs ?? 0) as UsageSummaryRow[]
  }
}

let defaultMeter: UsageMeter | null = null

/** Record a usage entry without ever throwing. Returns false when the store failed. */
export function recordUsage(entry: UsageEntry, meter?: UsageMeter): boolean {
  try {
    ;(meter ?? (defaultMeter ??= new UsageMeter())).record(entry)
    return true
  } catch (err) {
    logger.warn({ err }, 'Usage metering failed (turn unaffected)')
    return false
  }
}
