/**
 * Every tool call, allowed or not, goes into the tamper-evident audit log
 * (audit-log.ts). Card #196, part 1.
 *
 * gateToolCall (scope-gate.ts) is the one checkpoint both runtimes pass before
 * a tool runs, so it records here: who asked (the actor), which run (the
 * session id), the tool, what it was pointed at, and the outcome. Calls that
 * would write into the audit store itself are refused, whatever TOOL_GUARD
 * says; that check is exact paths, not phrasing, so it does not misfire.
 *
 * Where the log lives:
 *   - /var/lib/havn-audit on a hosted box. Root creates audit.jsonl there with
 *     the append-only flag (chattr +a), so the havn user can add lines but not
 *     edit, truncate or delete them. When that file exists it is always used:
 *     .env cannot move the log somewhere the assistant could rewrite.
 *   - AUDIT_DIR anywhere else (opt-in; must be outside the install).
 *   - Nowhere when neither is set. Recording is then skipped.
 *
 * What a record holds: shell commands and file paths, redacted and cut at 500
 * characters. File contents are never recorded, and for MCP and other tools
 * only the argument names are, because those arguments are message bodies and
 * documents and this log is copied off the box (part 2).
 *
 * Recording fails open: a full disk or a missing directory must not stop the
 * assistant working. A failure is logged loudly, and the off-box witness's
 * silence check (part 3) catches a log that stopped growing.
 *
 * Honest limit: the assistant owns its own code under the install directory,
 * so a determined agent could patch this out. The append-only file keeps what
 * was already written; the off-box witness shows when writing stopped.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AuditLog, storeTouch, type AuditEvent } from './audit-log.js'
import { redactSensitive } from '../support/redact.js'
import { logger } from '../logger.js'

export const HOSTED_AUDIT_DIR = '/var/lib/havn-audit'
const DETAIL_MAX = 500

// --- who is acting ----------------------------------------------------------

const actorStore = new AsyncLocalStorage<string>()

/**
 * Run `fn` with an actor attached, e.g. `chat:<id>` or `job:<task id>`. Tool
 * calls the agent makes inside it, however deep, are recorded under that
 * actor. Calls outside any withActor are recorded as "unattributed".
 */
export function withActor<T>(actor: string, fn: () => T): T {
  return actorStore.run(actor, fn)
}

export function currentActor(): string {
  return actorStore.getStore() ?? 'unattributed'
}

// --- what the call was ------------------------------------------------------

const BASH_TOOLS = new Set(['Bash', 'bash'])
const WRITE_TOOLS = new Set(['Write', 'write_file'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'edit_file'])
const PATH_TOOLS = new Set([...WRITE_TOOLS, ...EDIT_TOOLS, 'Read', 'read_file', 'Grep', 'Glob', 'LS'])

function args(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function pathOf(o: Record<string, unknown>): string | undefined {
  return str(o.file_path) ?? str(o.path) ?? str(o.notebook_path)
}

/**
 * One line saying what a tool call targeted, without its payload: the
 * command for a shell, the path (and pattern) for file tools, the URL for a
 * fetch, and only argument names for everything else.
 */
export function describeToolCall(tool: string, input: unknown): string {
  const o = args(input)
  let target: string
  if (BASH_TOOLS.has(tool)) target = str(o.command) ?? ''
  else if (PATH_TOOLS.has(tool)) target = [pathOf(o), str(o.pattern)].filter(Boolean).join(' ')
  else if (tool === 'WebFetch') target = str(o.url) ?? ''
  else {
    const keys = Object.keys(o)
    target = keys.length ? `{${keys.join(', ')}}` : ''
  }
  return redactSensitive(target ? `${tool} ${target}` : tool).slice(0, DETAIL_MAX)
}

/** Why this call would change the audit store, or null. */
export function storeTouchFor(log: AuditLog, tool: string, input: unknown): string | null {
  const o = args(input)
  if (BASH_TOOLS.has(tool)) {
    const command = str(o.command)
    return command ? storeTouch(log, { kind: 'bash', command }) : null
  }
  const path = pathOf(o)
  if (!path) return null
  if (WRITE_TOOLS.has(tool)) return storeTouch(log, { kind: 'write', path })
  if (EDIT_TOOLS.has(tool)) return storeTouch(log, { kind: 'edit', path })
  return null
}

// --- the shared log ---------------------------------------------------------

/** The hosted store when root has made it, else the configured dir, else null (off). */
export function resolveAuditDir(configured: string, hostedDir: string = HOSTED_AUDIT_DIR): string | null {
  if (existsSync(join(hostedDir, 'audit.jsonl'))) return hostedDir
  return configured.trim() || null
}

export type ToolOutcome = AuditEvent['outcome']

export class AuditTrail {
  constructor(readonly log: AuditLog) {}

  /** Refusal text for the model when a call reaches into the store, or null. */
  refuse(tool: string, input: unknown): string | null {
    try {
      return storeTouchFor(this.log, tool, input)
    } catch {
      return null
    }
  }

  /** Append one record. Returns its evidence locator, or undefined when the write failed. */
  record(call: { session: string; tool: string; input: unknown }, outcome: ToolOutcome, note?: string): string | undefined {
    try {
      const detail = describeToolCall(call.tool, call.input) + (note ? ` :: ${redactSensitive(note)}` : '')
      const e = this.log.append({
        runId: call.session || 'unknown',
        actor: currentActor(),
        action: call.tool,
        outcome,
        detail: detail.slice(0, DETAIL_MAX),
      })
      return `${this.log.file}#${e.seq}`
    } catch (err) {
      warnOnce(`audit record failed: ${String(err)}`)
      return undefined
    }
  }
}

const RETRY_MS = 5 * 60_000
let shared: { key: string; trail: AuditTrail | null; at: number } | null = null
let lastWarning = ''

function warnOnce(msg: string): void {
  if (msg === lastWarning) return
  lastWarning = msg
  logger.error(msg)
}

/**
 * The process-wide trail, or null when auditing is off or the store cannot be
 * opened (retried every few minutes, so fixing the directory needs no restart).
 */
export function getAuditTrail(configuredDir: string, workspace: string, hostedDir: string = HOSTED_AUDIT_DIR): AuditTrail | null {
  const dir = resolveAuditDir(configuredDir, hostedDir)
  if (!dir) return null
  const key = `${dir}\0${workspace}`
  if (shared && shared.key === key && (shared.trail || Date.now() - shared.at < RETRY_MS)) return shared.trail
  let trail: AuditTrail | null = null
  try {
    trail = new AuditTrail(new AuditLog({ dir, workspace }))
  } catch (err) {
    warnOnce(`audit log unavailable at ${dir}: ${String(err)}`)
  }
  shared = { key, trail, at: Date.now() }
  return trail
}

/** Tests only. */
export function resetAuditTrail(): void {
  shared = null
  lastWarning = ''
}
