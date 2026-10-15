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
 * that witness.
 *
 * Card #196 wired it into the tool path (audit-trail.ts). The chain head is
 * tracked in memory from the last line on disk, so an append never rereads a
 * log. A synchronous witness is optional: the off-box one is asynchronous, and
 * ships `eventsAfter(seq)` from the append-only file itself, so the file is
 * the outbox and nothing the agent can edit sits between it and the witness.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
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
  /** The last event, without reading everything. Falls back to readAll(). */
  last?(): AuditEvent | undefined
}

export class MemorySink implements AuditSink {
  private events: AuditEvent[] = []
  append(e: AuditEvent): void { this.events.push(structuredClone(e)) }
  readAll(): AuditEvent[] { return structuredClone(this.events) }
  last(): AuditEvent | undefined { const e = this.events[this.events.length - 1]; return e && structuredClone(e) }
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
  last(): AuditEvent | undefined { return tailOf(this.file).last }
}

const GENESIS = '0'.repeat(64)

export function hashOf(e: Omit<AuditEvent, 'hash'>): string {
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

/** How far back from the end to look for the last line. Lines are capped well under this. */
const TAIL_BYTES = 64 * 1024

/**
 * The last complete event in a log file, read from its tail, and whether the
 * file ends mid-line (a crash during a write). Unparseable tails count as no
 * event: the caller continues from the witness or genesis and verify() flags
 * the break.
 */
function tailOf(file: string): { last?: AuditEvent; torn: boolean } {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return { torn: false } }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return { torn: false }
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const text = buf.toString('utf-8')
    const torn = !text.endsWith('\n')
    const lines = text.split('\n').filter(Boolean)
    if (torn) lines.pop()
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as AuditEvent
        if (typeof e.seq === 'number' && typeof e.hash === 'string') return { last: e, torn }
      } catch {
        // The first line of the window may be cut; keep looking back.
      }
    }
    return { torn }
  } finally {
    closeSync(fd)
  }
}

export class AuditLog {
  readonly dir: string
  readonly file: string
  private witness?: AuditSink
  private workspace: string
  private head: { seq: number; hash: string }
  private torn: boolean

  constructor(opts: { dir: string; workspace: string; witness?: AuditSink }) {
    if (isInside(opts.dir, opts.workspace) || isInside(opts.workspace, opts.dir)) {
      throw new Error('audit store must be outside the agent workspace')
    }
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    this.dir = opts.dir
    this.file = join(opts.dir, 'audit.jsonl')
    this.witness = opts.witness
    this.workspace = opts.workspace
    // Read once. A synchronous witness that is ahead of the local file (a
    // wiped or truncated primary) wins, so the chain cannot be reset.
    const tail = tailOf(this.file)
    this.torn = tail.torn
    const w = opts.witness ? (opts.witness.last ? opts.witness.last() : opts.witness.readAll().at(-1)) : undefined
    const from = w && (!tail.last || w.seq > tail.last.seq) ? w : tail.last
    this.head = { seq: from?.seq ?? 0, hash: from?.hash ?? GENESIS }
  }

  /** The chain head: what the next event links to. */
  headOf(): { seq: number; hash: string } { return { ...this.head } }

  private readLocal(): AuditEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf-8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) as AuditEvent } catch { return { seq: -1 } as AuditEvent }
    })
  }

  /** Links to the tracked head; the head moves only once the local write succeeded. */
  append(input: AuditInput): AuditEvent {
    const base = { seq: this.head.seq + 1, ts: new Date().toISOString(), ...input, prevHash: this.head.hash }
    const event: AuditEvent = { ...base, hash: hashOf(base) }
    this.witness?.append(event)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    // After a torn write, start a fresh line so this event is not glued to it.
    appendFileSync(this.file, (this.torn ? '\n' : '') + JSON.stringify(event) + '\n', { mode: 0o600 })
    this.torn = false
    this.head = { seq: event.seq, hash: event.hash }
    return event
  }

  /**
   * Complete events from byte `offset` on, at most `max`, each with the byte
   * offset just past its line. Lets a shipper resume where it left off
   * without rereading a log that only grows. Unparseable lines (a torn
   * write) are skipped; their bytes are still counted.
   */
  readFrom(offset: number, max: number): { events: AuditEvent[]; ends: number[] } {
    const events: AuditEvent[] = []
    const ends: number[] = []
    let fd: number
    try { fd = openSync(this.file, 'r') } catch { return { events, ends } }
    try {
      const size = fstatSync(fd).size
      let pos = offset
      let carry = Buffer.alloc(0)
      const chunk = Buffer.alloc(1024 * 1024)
      while (pos < size && events.length < max) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos)
        if (n <= 0) break
        const buf = Buffer.concat([carry, chunk.subarray(0, n)])
        const base = pos - carry.length
        pos += n
        let start = 0
        let nl: number
        while ((nl = buf.indexOf(0x0a, start)) !== -1 && events.length < max) {
          const line = buf.subarray(start, nl).toString('utf-8')
          start = nl + 1
          if (!line) continue
          try {
            const e = JSON.parse(line) as AuditEvent
            if (typeof e.seq === 'number' && typeof e.hash === 'string') {
              events.push(e)
              ends.push(base + start)
            }
          } catch {
            // Torn line: not an event.
          }
        }
        carry = Buffer.from(buf.subarray(start))
      }
      return { events, ends }
    } finally {
      closeSync(fd)
    }
  }

  /** Events after `seq`, oldest first: what an asynchronous witness has not acknowledged yet. */
  eventsAfter(seq: number): AuditEvent[] {
    return this.readLocal().filter(e => e.seq > seq)
  }

  verify(): VerifyResult {
    const issues: string[] = []
    const local = this.readLocal()
    const witness = this.witness?.readAll()
    let prev = GENESIS
    for (const [i, e] of local.entries()) {
      const { hash, ...rest } = e
      if (e.seq !== i + 1) issues.push(`event ${i + 1}: sequence broken (got ${e.seq})`)
      if (e.prevHash !== prev) issues.push(`event ${i + 1}: chain link broken`)
      if (hashOf(rest) !== hash) issues.push(`event ${i + 1}: hash mismatch (edited)`)
      prev = hash
      if (!witness) continue
      const w = witness[i]
      if (!w || w.hash !== hash) issues.push(`event ${i + 1}: not in witness (fabricated or altered)`)
    }
    if (witness && local.length < witness.length) issues.push(`${witness.length - local.length} event(s) missing from primary log (truncated or deleted)`)
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

/** Why a write, edit or shell command reaches into the audit store, or null. Exact, no phrasing rules. */
export function storeTouch(log: AuditLog, action: Exclude<GuardAction, { kind: 'message' }>): string | null {
  if (action.kind === 'bash') return bashTouchesStore(log, action.command)
  return log.protects(action.path) ? 'path is inside the audit store' : null
}

export function guardAction(log: AuditLog, ctx: GuardCtx, action: GuardAction): GuardDecision {
  let reason: string | null = null
  let detail = ''
  if (action.kind === 'write' || action.kind === 'edit') {
    detail = action.path
    reason = storeTouch(log, action)
  } else if (action.kind === 'bash') {
    detail = action.command.slice(0, 500)
    reason = storeTouch(log, action)
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
