/**
 * At-most-once side effects (card #229, from spike #217).
 *
 * Every effect that reaches another person (an email send, a Slack post) is
 * keyed by run, kind and target, and written here BEFORE the call goes out.
 * A second attempt with the same key in the same run is refused and logged,
 * so a retry, a restart, a scheduler rerun or a parallel subagent cannot send
 * it twice.
 *
 * What a run is:
 *   - a scheduled job's run: `job:<task id>` for a one-shot, `job:<task id>@<due
 *     time>` for a recurring one. A deferred retry and a rerun after a crash
 *     reuse it, which is the point.
 *   - an approval card: `card:<chat>:<message>`, for as long as the card can be
 *     tapped.
 *   - any other turn: a fresh key per turn. A new request from the owner is a
 *     new run, so "send it again" from the owner always works.
 *
 * The key reaches tool subprocesses as AGENT_RUN_KEY, so the send CLIs check
 * the journal themselves (they know the real recipients). Commands the gate
 * can read from the outside (gog gmail send, slack post) are checked there.
 * No run key means nobody started a run (the owner at a terminal): no check.
 *
 * States: `pending` is written before the call and stays when the outcome is
 * unknown (a timeout after the request left). A pending key is refused like a
 * done one: at-most-once prefers asking the owner over a second send. Only a
 * failure the destination confirmed (it answered and refused) releases the key.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { SEND_RECIPIENT_LIMIT } from '../config.js'
import { logger } from '../logger.js'
import { wasNotSent } from './not-sent.js'

export { markNotSent, wasNotSent } from './not-sent.js'

export const RUN_KEY_ENV = 'AGENT_RUN_KEY'

// --- which run is acting ----------------------------------------------------

const runStore = new AsyncLocalStorage<string>()

/** Run `fn` as one run. Effects inside it, however deep, share its key. */
export function withRun<T>(runKey: string, fn: () => T): T {
  return runStore.run(runKey, fn)
}

/** Keep the run already in force, or start a fresh one for this turn. */
export function withRunOrNew<T>(prefix: string, fn: () => T): T {
  return runStore.getStore() ? fn() : runStore.run(`${prefix}:${randomUUID()}`, fn)
}

/** The run in force here, or the one a parent process handed down. */
export function currentRun(): string | undefined {
  return runStore.getStore() ?? (process.env[RUN_KEY_ENV]?.trim() || undefined)
}

/** Env for a tool subprocess: the parent's env plus the run key. */
export function runEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const run = runStore.getStore()
  return run ? { ...base, [RUN_KEY_ENV]: run } : base
}

/**
 * The `env` option for a runtime that spawns tools: undefined when there is
 * neither a lane env nor a run (keep the SDK default), else the env with the
 * run key added.
 */
export function runEnvOption<E extends Record<string, string | undefined>>(laneEnv: E | undefined): E | NodeJS.ProcessEnv | undefined {
  const run = runStore.getStore()
  if (!run) return laneEnv
  return { ...(laneEnv ?? process.env), [RUN_KEY_ENV]: run }
}

/** A scheduled task's run key. A one-shot runs once, so its id is enough. */
export function jobRunKey(taskId: string, dueAt: number, runOnce: boolean): string {
  return runOnce ? `job:${taskId}` : `job:${taskId}@${dueAt}`
}

export function cardRunKey(chatId: string, messageId: string): string {
  return `card:${chatId}:${messageId}`
}

// --- the journal ------------------------------------------------------------

export type EffectSpec = {
  /** e.g. 'email.send', 'slack.post'. */
  kind: string
  /** What makes this effect this effect: recipients plus subject, a channel plus text. */
  target: string
  /** Everyone it reaches, counted against the per-run recipient limit. */
  recipients?: string[]
}

export type BeginResult =
  | { ok: true; key: string | null }
  | { ok: false; reason: 'duplicate' | 'unconfirmed' | 'recipient-limit'; message: string }

let ready: Database.Database | null = null

export function initEffectJournalTables(d: Database.Database = getDb()): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS effect_journal (
      key TEXT PRIMARY KEY,
      run_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      recipients TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      repeats INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_effect_journal_run ON effect_journal(run_key)')
  ready = d
}

function db(): Database.Database {
  const d = getDb()
  if (ready !== d) initEffectJournalTables(d)
  return d
}

const now = () => Math.floor(Date.now() / 1000)

export function effectKey(runKey: string, spec: Pick<EffectSpec, 'kind' | 'target'>): string {
  return createHash('sha256').update(`${runKey}\n${spec.kind}\n${spec.target}`).digest('hex').slice(0, 32)
}

/** Recipients and subject, normalised, so a redraft of the same email keys the same. */
export function emailTarget(recipients: string[], subject: string): string {
  const to = normaliseRecipients(recipients).join(',')
  return `${to}|${subject.trim().replace(/\s+/g, ' ').toLowerCase()}`
}

export function normaliseRecipients(list: string[]): string[] {
  return [...new Set(list.map(r => r.trim().toLowerCase()).filter(Boolean))].sort()
}

/**
 * Claim an effect before it goes out. `ok` with a key means go, then call
 * commitEffect or releaseEffect. `ok` with a null key means there is no run
 * to hold it against (nothing is checked or recorded).
 */
export function beginEffect(spec: EffectSpec, runKey: string | undefined = currentRun()): BeginResult {
  if (!runKey) return { ok: true, key: null }
  const d = db()
  const key = effectKey(runKey, spec)
  const recipients = normaliseRecipients(spec.recipients ?? [])
  const t = now()
  const claim = d.transaction((): BeginResult => {
    const prior = d.prepare('SELECT status FROM effect_journal WHERE key = ?').get(key) as { status: string } | undefined
    if (prior) {
      d.prepare('UPDATE effect_journal SET repeats = repeats + 1, updated_at = ? WHERE key = ?').run(t, key)
      return prior.status === 'done'
        ? { ok: false, reason: 'duplicate', message: `Refused: this ${spec.kind} already went out in this run, so it was not sent again. If the owner wants it sent again, they can ask in a new message.` }
        : { ok: false, reason: 'unconfirmed', message: `Refused: this ${spec.kind} was already attempted in this run and may have gone out (no confirmation came back). Not sending it twice. Check Sent, and if it is not there the owner can ask again in a new message.` }
    }
    if (recipients.length) {
      const reached = new Set<string>()
      for (const r of d.prepare('SELECT recipients FROM effect_journal WHERE run_key = ?').all(runKey) as { recipients: string }[]) {
        for (const x of JSON.parse(r.recipients) as string[]) reached.add(x)
      }
      const total = new Set([...reached, ...recipients])
      if (total.size > SEND_RECIPIENT_LIMIT) {
        return { ok: false, reason: 'recipient-limit', message: `Refused: this run would reach ${total.size} people, over the limit of ${SEND_RECIPIENT_LIMIT} per run (SEND_RECIPIENT_LIMIT). Nothing was sent. Ask the owner to confirm the list in a new message.` }
      }
    }
    d.prepare(
      `INSERT INTO effect_journal (key, run_key, kind, target, recipients, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(key, runKey, spec.kind, spec.target, JSON.stringify(recipients), t, t)
    return { ok: true, key }
  })
  const r = claim.immediate()
  if (!r.ok) logger.warn({ run: runKey, kind: spec.kind, reason: r.reason }, 'refused a repeated or over-limit effect')
  return r
}

/** The destination confirmed it. */
export function commitEffect(key: string | null): void {
  if (!key) return
  db().prepare("UPDATE effect_journal SET status = 'done', updated_at = ? WHERE key = ?").run(now(), key)
}

/** The destination answered and refused: nothing went out, so a retry may try again. */
export function releaseEffect(key: string | null): void {
  if (!key) return
  db().prepare("DELETE FROM effect_journal WHERE key = ? AND status = 'pending'").run(key)
}

/**
 * Run one effect under the journal: claim, call, then commit, or release
 * when the destination confirmed nothing went out. A refusal throws with the
 * message for the agent.
 */
export async function guardedEffect<T>(spec: EffectSpec, send: () => Promise<T>, runKey: string | undefined = currentRun()): Promise<T> {
  const claim = beginEffect(spec, runKey)
  if (!claim.ok) throw new Error(claim.message)
  try {
    const out = await send()
    commitEffect(claim.key)
    return out
  } catch (err) {
    if (wasNotSent(err)) releaseEffect(claim.key)
    throw err
  }
}

export type JournalRow = { key: string; run_key: string; kind: string; target: string; recipients: string; status: string; repeats: number }

export function journalForRun(runKey: string): JournalRow[] {
  return db().prepare('SELECT key, run_key, kind, target, recipients, status, repeats FROM effect_journal WHERE run_key = ? ORDER BY created_at').all(runKey) as JournalRow[]
}
