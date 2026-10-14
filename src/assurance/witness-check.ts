/**
 * The box's own watch on its audit log (card #196, part 3).
 *
 * Every hour the box looks at its shipping state: a conflict the shipper
 * recorded, or events still waiting to leave more than an hour after they were
 * written. Once a day it also runs the full check: the local chain verifies,
 * and the witness's head is an event this log still holds, with the same hash.
 * That last part catches what shipping alone cannot: an event edited after it
 * was sent, or a log cut back to before what the witness holds.
 *
 * Problems go to the box's owner on Telegram, in plain words, once per problem
 * and again every 24 hours while it lasts. Every check is also reported to the
 * witness as kinds only (`POST /v1/check`), which is the box's hourly
 * heartbeat: the witness's daily cron tells the operator about a box that
 * stopped checking in, so turning this off on the box does not go unnoticed.
 *
 * Honest limit: someone in control of the box can make it report "ok". What
 * they cannot change is what the witness already holds, and the witness's
 * silence and conflict alerts do not depend on the box telling the truth.
 *
 * A check never touches a tool call and never throws.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { readWitnessState, witnessStatePath } from './witness.js'
import type { CheckKind, CheckReport, Head } from './witness-protocol.js'
import { logger } from '../logger.js'

export const BACKLOG_MS = 60 * 60_000
export const FULL_CHECK_MS = 24 * 60 * 60_000
export const REMIND_MS = 24 * 60 * 60_000

export type CheckState = {
  lastFullAt?: string
  /** What the last full check found, carried between full checks. */
  fullProblems?: CheckKind[]
  /** When the owner was last told about each problem still open. */
  alerted: Partial<Record<CheckKind, string>>
}

export type CheckResult = { report: CheckReport; notes: Partial<Record<CheckKind, string>>; told: CheckKind[] }

/** What the owner reads. Plain language: hosted clients are not technical. */
export const OWNER_MESSAGES: Record<CheckKind, string> = {
  conflict:
    'Security notice: the copy of my activity log that is kept off this server no longer matches the log here, so I have stopped sending to it. ' +
    'That can mean the log on this server was changed. Your assistant still works normally. Please let your Havn contact know so they can check.',
  mismatch:
    'Security notice: my activity log on this server is missing entries, or has entries that differ from the copy kept off this server. ' +
    'Your assistant still works normally. Please let your Havn contact know so they can check.',
  broken:
    'Security notice: my activity log on this server failed its integrity check, which means an entry in it was changed or removed. ' +
    'Your assistant still works normally. Please let your Havn contact know so they can check.',
  backlog:
    'Heads-up: I have not been able to send my activity log to its off-server copy for over an hour. ' +
    'Nothing is lost, it waits here and goes out once the connection is back. If this message repeats tomorrow, please let your Havn contact know.',
}

export function checkStatePath(auditDir: string): string {
  return join(auditDir, 'witness-check.json')
}

function readCheckState(path: string): CheckState {
  try {
    const s = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CheckState>
    return { lastFullAt: s.lastFullAt, fullProblems: s.fullProblems ?? [], alerted: s.alerted ?? {} }
  } catch {
    return { alerted: {} }
  }
}

function saveCheckState(path: string, state: CheckState): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export class WitnessChecker {
  private log: AuditLog
  private url: string
  private token: string
  private fetchImpl: typeof fetch
  private notify: (text: string) => Promise<boolean>
  private now: () => number

  constructor(opts: { log: AuditLog; url: string; token: string; notify: (text: string) => Promise<boolean>; fetchImpl?: typeof fetch; now?: () => number }) {
    this.log = opts.log
    this.url = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.notify = opts.notify
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
  }

  private async witness(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
  }

  /** The full check: local chain, then the witness head against this log. */
  private async fullCheck(notes: Partial<Record<CheckKind, string>>): Promise<boolean> {
    const v = this.log.verify()
    if (!v.ok) notes.broken = v.issues.slice(0, 3).join('; ')
    let head: Head
    try {
      const res = await this.witness('/v1/head')
      if (!res.ok) return false
      head = ((await res.json()) as { head: Head }).head
    } catch {
      return false // unreachable: the backlog check covers a lasting outage
    }
    if (head.seq > 0) {
      const held = this.log.eventsAfter(head.seq - 1)[0]
      if (!held || held.seq !== head.seq) notes.mismatch = `the witness holds event ${head.seq}, this log ends at ${v.events}`
      else if (held.hash !== head.hash) notes.mismatch = `event ${head.seq} differs from the witness copy`
    }
    return true
  }

  async checkOnce(): Promise<CheckResult> {
    const now = this.now()
    const statePath = checkStatePath(this.log.dir)
    const state = readCheckState(statePath)
    const shipping = readWitnessState(witnessStatePath(this.log.dir))
    const notes: Partial<Record<CheckKind, string>> = {}

    if (shipping.conflict) notes.conflict = shipping.conflict.reason
    const next = this.log.readFrom(shipping.offset, 1).events[0]
    if (next && now - Date.parse(next.ts) > BACKLOG_MS) notes.backlog = shipping.lastError ?? `event ${next.seq} unsent since ${next.ts}`

    let full = false
    if (!state.lastFullAt || now - Date.parse(state.lastFullAt) >= FULL_CHECK_MS) {
      full = await this.fullCheck(notes)
      if (full) {
        state.lastFullAt = new Date(now).toISOString()
        state.fullProblems = (['broken', 'mismatch'] as const).filter((k) => notes[k])
      }
    } else {
      // Between full checks, carry forward what the last one found, so an open
      // problem is not reported as cleared just because this was a light check.
      for (const k of state.fullProblems ?? []) notes[k] ??= 'still open from the last full check'
    }

    const problems = Object.keys(notes) as CheckKind[]
    const told: CheckKind[] = []
    for (const k of Object.keys(state.alerted) as CheckKind[]) if (!notes[k]) delete state.alerted[k]
    for (const k of problems) {
      const last = state.alerted[k]
      if (last && now - Date.parse(last) < REMIND_MS) continue
      if (await this.notify(OWNER_MESSAGES[k]).catch(() => false)) {
        state.alerted[k] = new Date(now).toISOString()
        told.push(k)
      }
    }
    if (problems.length) logger.error({ problems: notes }, 'audit witness check found problems')
    saveCheckState(statePath, state)

    const report: CheckReport = { ok: problems.length === 0, problems, full }
    try {
      await this.witness('/v1/check', { method: 'POST', body: JSON.stringify(report) })
    } catch {
      // The heartbeat is best effort; a missing one is what the witness alerts on.
    }
    return { report, notes, told }
  }
}

/** Check every `intervalMs` (first after `firstMs`). Never overlaps, never throws. */
export function startWitnessChecks(make: () => WitnessChecker | null, intervalMs = 60 * 60_000, firstMs = 2 * 60_000): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await make()?.checkOnce()
    } catch (err) {
      logger.warn({ err: String(err) }, 'audit witness check failed, will retry')
    } finally {
      running = false
    }
  }
  const first = setTimeout(() => void tick(), firstMs)
  const timer = setInterval(() => void tick(), intervalMs)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
