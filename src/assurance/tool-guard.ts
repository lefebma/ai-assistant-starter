/**
 * The evasion monitor (evasion.ts, card #170) wired into tool execution.
 * Card #194.
 *
 * Every shell and file tool call, on both runtimes, is turned into the command
 * text the monitor understands and checked before it runs. TOOL_GUARD picks
 * what happens on a hit:
 *
 *   off      nothing is checked
 *   log      (default) the would-be block is recorded and the call goes ahead
 *   enforce  the call is refused and the model is told why and what to do
 *            instead
 *
 * Log mode is how this ships: it measures how often the rules would fire on
 * real work, and how many of those are false refusals, before anything is
 * blocked. /guard report summarises the log.
 *
 * Only the tools that touch the shell or the filesystem are checked. MCP tool
 * arguments are free text (an email body can mention ".env") and checking them
 * lexically would mostly produce false refusals; their limits belong to the
 * role-scoped capabilities in card #195.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { EvasionMonitor, type Decision } from './evasion.js'
import { redactSensitive } from '../support/redact.js'

export type GuardMode = 'off' | 'log' | 'enforce'

export function parseGuardMode(raw: string | undefined): GuardMode {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'off' || v === 'enforce' ? v : 'log'
}

const PATH_TOOLS: Record<string, string> = {
  // Claude Code tool names
  Read: 'cat',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'grep',
  // ai-sdk runtime tool names
  read_file: 'cat',
  write_file: 'write',
  edit_file: 'edit',
}

/**
 * The command text the monitor should judge for a tool call, or null when the
 * tool is not one this guard checks. File tools become "verb path" so the
 * monitor's path rules (secrets files, ssh keys) apply to them as to `cat`.
 */
export function commandText(toolName: string, input: unknown): string | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (toolName === 'Bash' || toolName === 'bash') return typeof o.command === 'string' ? o.command : null
  const verb = PATH_TOOLS[toolName]
  if (!verb) return null
  const path = [o.file_path, o.path, o.notebook_path].find((p): p is string => typeof p === 'string' && p.length > 0)
  // Grep with no path searches the workspace, which is fine; only a named file can be a secret.
  return path ? `${verb} ${path}` : null
}

export interface GuardEntry {
  at: string
  mode: GuardMode
  session: string
  tool: string
  command: string
  rule: string
  family?: string
  evasion: boolean
  /** The monitor's mode after this call: normal, restricted or stopped. */
  monitorMode: Decision['mode']
  strikes?: number
  enforced: boolean
}

export interface GuardVerdict {
  allow: boolean
  /** Shown to the model when a call is refused. */
  reason?: string
  entry?: GuardEntry
}

export class ToolGuard {
  readonly mode: GuardMode
  private monitor: EvasionMonitor
  private record: (e: GuardEntry) => void

  constructor(opts: { mode: GuardMode; monitor?: EvasionMonitor; record?: (e: GuardEntry) => void }) {
    this.mode = opts.mode
    this.monitor = opts.monitor ?? new EvasionMonitor()
    this.record = opts.record ?? (() => {})
  }

  check(call: { session: string; tool: string; input: unknown }): GuardVerdict {
    if (this.mode === 'off') return { allow: true }
    const text = commandText(call.tool, call.input)
    if (text === null) return { allow: true }
    const d = this.monitor.check(call.session || 'unknown', text)
    if (d.allowed) return { allow: true }

    const enforced = this.mode === 'enforce'
    const entry: GuardEntry = {
      at: new Date().toISOString(),
      mode: this.mode,
      session: call.session || 'unknown',
      tool: call.tool,
      command: redactSensitive(text).slice(0, 300),
      rule: d.rule ?? 'unknown',
      family: d.family,
      evasion: d.evasion,
      monitorMode: d.mode,
      strikes: d.relatedStrikes,
      enforced,
    }
    try {
      this.record(entry)
    } catch {
      // Recording must never break a tool call.
    }
    if (!enforced) {
      // Log mode keeps measuring: a run the monitor would have stopped is
      // resumed here, or every later call would log as "run-stopped" noise.
      if (d.mode === 'stopped') this.monitor.resume(entry.session, 'log-mode')
      return { allow: true, entry }
    }
    const why = d.rule === 'run-stopped'
      ? 'This run was stopped after repeated blocked attempts and needs the owner to review it.'
      : `Blocked by the tool guard (${d.rule}).`
    return { allow: false, reason: [why, d.suggestion].filter(Boolean).join(' '), entry }
  }
}

// --- the log ----------------------------------------------------------------

export function appendGuardLog(path: string): (e: GuardEntry) => void {
  return (e) => {
    mkdirSync(dirname(path), { recursive: true })
    // A crash mid-write leaves a line with no newline; start a fresh line so
    // this entry is not glued onto it and lost with it.
    let lead = ''
    try {
      const size = statSync(path).size
      if (size > 0) {
        const fd = openSync(path, 'r')
        const last = Buffer.alloc(1)
        readSync(fd, last, 0, 1, size - 1)
        closeSync(fd)
        if (last[0] !== 0x0a) lead = '\n'
      }
    } catch {
      // No file yet.
    }
    appendFileSync(path, lead + JSON.stringify(e) + '\n', { mode: 0o600 })
  }
}

export function readGuardLog(path: string, sinceMs = 0): GuardEntry[] {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const out: GuardEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as GuardEntry
      if (Date.parse(e.at) >= sinceMs) out.push(e)
    } catch {
      // A torn line from a crash mid-write: skip it.
    }
  }
  return out
}

/** Plain-language summary for /guard report. */
export function formatGuardReport(entries: GuardEntry[], mode: GuardMode, days: number): string {
  const head = `Tool guard is in ${mode} mode. Last ${days} day${days === 1 ? '' : 's'}:`
  if (!entries.length) {
    return `${head} no tool call matched a rule.${mode === 'log' ? ' Nothing would have been blocked.' : ''}`
  }
  const byRule = new Map<string, number>()
  for (const e of entries) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1)
  const evasion = entries.filter((e) => e.evasion).length
  const restricted = entries.filter((e) => e.monitorMode === 'restricted').length
  const stops = entries.filter((e) => e.rule !== 'run-stopped' && e.monitorMode === 'stopped').length
  const verb = mode === 'enforce' ? 'blocked' : 'would have been blocked'
  const lines = [
    head,
    `${entries.length} tool call${entries.length === 1 ? '' : 's'} ${verb}.`,
    ...[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([rule, n]) => `  ${rule}: ${n}`),
    `Looked like evasion (obfuscated, split, or a retry after a block): ${evasion}.`,
    `Calls made while privileges were reduced: ${restricted}. Runs that would have stopped for you: ${stops}.`,
    '',
    'Most recent:',
    ...entries.slice(-8).reverse().map((e) => `  ${e.at.slice(0, 16).replace('T', ' ')} ${e.tool} [${e.rule}] ${e.command.slice(0, 90)}`),
  ]
  if (mode === 'log') {
    lines.push('', 'Each one above is either a real catch or a false refusal. If they all look like real catches, set TOOL_GUARD=enforce.')
  }
  return lines.join('\n')
}

// --- the shared instance ----------------------------------------------------

let shared: ToolGuard | null = null

/** One guard per process, so a session's strikes carry across turns. */
export function getToolGuard(mode: GuardMode, storeDir: string): ToolGuard {
  if (!shared || shared.mode !== mode) {
    shared = new ToolGuard({ mode, record: appendGuardLog(resolve(storeDir, 'tool-guard.jsonl')) })
  }
  return shared
}

export function guardLogPath(storeDir: string): string {
  return resolve(storeDir, 'tool-guard.jsonl')
}
