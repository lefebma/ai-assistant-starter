/**
 * Tamper-resistant audit trail (card 169).
 *
 * Properties this module provides:
 *  1. The log lives OUTSIDE the agent workspace (enforced at construction).
 *  2. Every event is hash-chained and mirrored to an independent witness sink
 *     at write time, so editing, truncating, deleting or fabricating events in
 *     the primary file is detectable, and the witness alone reconstructs the
 *     record after a host compromise.
 *  3. guardAction() sits in front of tools/shell and inbound text: any action
 *     that touches the audit store, or any instruction to erase traces (direct
 *     or arriving via untrusted content), is blocked and itself recorded with
 *     actor, run, action and an evidence locator (`<file>#<seq>`).
 *
 * Honest limits: guardAction is a lexical/path guard, not a sandbox. A shell
 * that builds the path at runtime defeats it. The real boundary is OS-level:
 * the log directory owned by another user (or append-only flag), and the
 * witness on a different host or volume. FileSink is the local stand-in for
 * that witness. Not yet wired into the runtime tool path.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'

export type AuditEvent = {
  seq: number
  ts: string
  runId: string
  actor: string
  action: string
  outcome: 'allowed' | 'blocked' | 'denied'
  detail: string
  prevHash: string
  hash: string
}
export type AuditInput = Omit<AuditEvent, 'seq' | 'ts' | 'prevHash' | 'hash'>

export interface AuditSink {
  append(event: AuditEvent): void
  readAll(): AuditEvent[]
}

export class MemorySink implements AuditSink {
  private events: AuditEvent[] = []
  append(e: AuditEvent): void { this.events.push(structuredClone(e)) }
  readAll(): AuditEvent[] { return structuredClone(this.events) }
}

export class FileSink implements AuditSink {
  readonly file: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'audit.jsonl')
  }
  append(e: AuditEvent): void { appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 }) }
  readAll(): AuditEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AuditEvent)
  }
}

const GENESIS = '0'.repeat(64)

function hashOf(e: Omit<AuditEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify([e.seq, e.ts, e.runId, e.actor, e.action, e.outcome, e.detail, e.prevHash])).digest('hex')
}

/** Resolve through symlinks where the path exists, else lexically. */
function canon(p: string): string {
  const abs = resolve(p)
  try { return realpathSync(abs) } catch {
    try { return join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1)) } catch { return abs }
  }
}

function isInside(child: string, parent: string): boolean {
  const c = canon(child), p = canon(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export type VerifyResult = { ok: boolean; issues: string[]; events: number }

export class AuditLog {
  readonly dir: string
  readonly file: string
  private witness: AuditSink
  private workspace: string

  constructor(opts: { dir: string; workspace: string; witness: AuditSink }) {
    if (isInside(opts.dir, opts.workspace) || isInside(opts.workspace, opts.dir)) {
      throw new Error('audit store must be outside the agent workspace')
    }
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    this.dir = opts.dir
    this.file = join(opts.dir, 'audit.jsonl')
    this.witness = opts.witness
    this.workspace = opts.workspace
  }

  private readLocal(): AuditEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf-8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) as AuditEvent } catch { return { seq: -1 } as AuditEvent }
    })
  }

  /** Next link continues from the WITNESS head, so a wiped primary cannot reset the chain. */
  append(input: AuditInput): AuditEvent {
    const w = this.witness.readAll()
    const last = w[w.length - 1]
    const base = { seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), ...input, prevHash: last?.hash ?? GENESIS }
    const event: AuditEvent = { ...base, hash: hashOf(base) }
    this.witness.append(event)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 })
    return event
  }

  verify(): VerifyResult {
    const issues: string[] = []
    const local = this.readLocal()
    const witness = this.witness.readAll()
    let prev = GENESIS
    for (const [i, e] of local.entries()) {
      const { hash, ...rest } = e
      if (e.seq !== i + 1) issues.push(`event ${i + 1}: sequence broken (got ${e.seq})`)
      if (e.prevHash !== prev) issues.push(`event ${i + 1}: chain link broken`)
      if (hashOf(rest) !== hash) issues.push(`event ${i + 1}: hash mismatch (edited)`)
      prev = hash
      const w = witness[i]
      if (!w || w.hash !== hash) issues.push(`event ${i + 1}: not in witness (fabricated or altered)`)
    }
    if (local.length < witness.length) issues.push(`${witness.length - local.length} event(s) missing from primary log (truncated or deleted)`)
    return { ok: issues.length === 0, issues, events: local.length }
  }

  /** Is this path inside the protected audit store? */
  protects(path: string): boolean { return isInside(path, this.dir) }
  get workspaceDir(): string { return this.workspace }
}

// ---- guard -----------------------------------------------------------------

const ERASURE = [
  /\b(delete|erase|wipe|clear|purge|truncate|remove|destroy|shred|overwrite|tamper with)\b[^.\n]{0,40}\b(audit|logs?|traces?|trail|history|evidence|records?)\b/i,
  /\bcover (up )?your tracks\b/i,
  /\b(hide|conceal|suppress)\b[^.\n]{0,30}\b(this|it|the action|what you did)\b[^.\n]{0,30}\b(from|in) (the )?(logs?|audit|owner|monitor)/i,
  /\b(do not|don'?t|never)\b[^.\n]{0,15}\b(log|record|audit)\b/i,
]

/** Returns the matched snippet when text instructs trace erasure, else null. */
export function detectTraceErasure(text: string): string | null {
  for (const re of ERASURE) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

export type GuardCtx = { runId: string; actor: string }
export type GuardAction =
  | { kind: 'write' | 'edit'; path: string }
  | { kind: 'bash'; command: string }
  | { kind: 'message'; text: string; source: string }

export type GuardDecision = { allowed: boolean; reason?: string; record?: AuditEvent; evidence?: string }

const DESTRUCTIVE_VERB = /\b(rm|rmdir|mv|truncate|shred|unlink|dd|chmod|chown|ln|tee|cp|sed|perl|python3?|node|ruby|open)\b|>>?|\bwrite\b/i

function bashTouchesStore(log: AuditLog, command: string): string | null {
  const dir = canon(log.dir)
  if (command.includes(log.dir) || command.includes(dir)) return 'command references the audit store'
  // Relative reach-ins like `cd ../audit` or `../audit/audit.jsonl`.
  const base = dir.split(sep).pop() ?? ''
  if (base && new RegExp(`(^|[\\s/='"])\\.\\.?/(?:[^\\s]*/)?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|\\s|$|'|")`).test(command)) {
    return 'command reaches the audit store via a relative path'
  }
  if (/audit\.jsonl/.test(command) && DESTRUCTIVE_VERB.test(command)) return 'command names the audit file with a write verb'
  return null
}

export function guardAction(log: AuditLog, ctx: GuardCtx, action: GuardAction): GuardDecision {
  let reason: string | null = null
  let detail = ''
  if (action.kind === 'write' || action.kind === 'edit') {
    detail = action.path
    if (log.protects(action.path)) reason = 'path is inside the audit store'
  } else if (action.kind === 'bash') {
    detail = action.command.slice(0, 500)
    reason = bashTouchesStore(log, action.command)
    if (!reason) reason = (() => { const m = detectTraceErasure(action.command); return m ? `trace-erasure phrasing: "${m}"` : null })()
  } else if (action.kind === 'message') {
    detail = `[${action.source}] ${action.text.slice(0, 500)}`
    const m = detectTraceErasure(action.text)
    if (m) reason = `${action.source.startsWith('untrusted') ? 'indirect injection' : 'direct instruction'} to erase traces: "${m}"`
  }
  if (!reason) return { allowed: true }
  const record = log.append({ runId: ctx.runId, actor: ctx.actor, action: action.kind, outcome: 'blocked', detail: `${detail} :: ${reason}` })
  return { allowed: false, reason, record, evidence: `${log.file}#${record.seq}` }
}
