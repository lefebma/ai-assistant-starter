/**
 * One checkpoint both runtimes call before a tool runs: the role (card #195)
 * for a scoped scheduled job, then the tool guard (card #194).
 *
 * A scoped job is checked against its role (fails closed) and then the tool
 * guard in enforce mode, whatever TOOL_GUARD says, because the owner chose to
 * restrict it and nobody is watching. Unscoped runs get TOOL_GUARD's mode (log
 * by default). The guard itself fails open.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, ROLES_FILE, STORE_DIR, TOOL_GUARD } from '../config.js'
import { logger } from '../logger.js'
import { getToolGuard, parseGuardMode } from './tool-guard.js'
import { allowedServers, canonicalTool, checkRole, exposureFor, loadRoles, mcpServerConfigs, refusalMessage, type RoleSpec } from './roles.js'
import type { RunScope } from '../runtime/types.js'

export interface RoleLogEntry {
  at: string
  role: string
  task?: string
  tool: string
  kind: string
  reason: string
  wouldAllow?: string
}

/** The scheduled-job part of /guard report. Empty string when nothing was refused. */
export function formatRoleReport(entries: RoleLogEntry[]): string {
  if (!entries.length) return ''
  const byTask = new Map<string, RoleLogEntry[]>()
  for (const e of entries) {
    const k = e.task ?? '(no task id)'
    byTask.set(k, [...(byTask.get(k) ?? []), e])
  }
  return [
    `Scheduled jobs refused outside their role: ${entries.length}.`,
    ...[...byTask.entries()].map(([task, es]) => {
      const last = es[es.length - 1]
      const fix = last.wouldAllow ? ` If it needs that, /schedule role ${task} ${last.wouldAllow}.` : ''
      return `  ${task} (${last.role}): ${es.length}x, latest: ${last.reason}.${fix}`
    }),
  ].join('\n')
}

export function roleLogPath(storeDir: string = STORE_DIR): string {
  return resolve(storeDir, 'role-log.jsonl')
}

function recordRole(e: RoleLogEntry): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    appendFileSync(roleLogPath(), JSON.stringify(e) + '\n', { mode: 0o600 })
  } catch {
    // Recording never decides the outcome.
  }
}

/** The role a scope names, or null for no scope. Throws for a role nobody defined. */
export function resolveRole(scope: RunScope | undefined): RoleSpec | null {
  if (!scope?.role) return null
  const role = loadRoles(ROLES_FILE).get(scope.role)
  if (!role) throw new Error(`role "${scope.role}" is not defined`)
  return role
}

export type GateResult = { allow: true } | { allow: false; reason: string }

export function gateToolCall(call: { session: string; tool: string; input: unknown; cwd: string; scope?: RunScope }): GateResult {
  if (call.scope?.role) {
    let v
    try {
      v = checkRole(loadRoles(ROLES_FILE), call.scope.role, { tool: call.tool, input: call.input, cwd: call.cwd })
    } catch (err) {
      logger.warn({ err: String(err) }, 'role check failed closed')
      return { allow: false, reason: 'Refused: the role check failed, so this scheduled job may not use tools right now.' }
    }
    if (!v.ok) {
      recordRole({ at: new Date().toISOString(), role: call.scope.role, task: call.scope.taskId, tool: canonicalTool(call.tool), kind: v.kind, reason: v.reason, wouldAllow: v.wouldAllow })
      logger.warn({ role: call.scope.role, task: call.scope.taskId, tool: call.tool, kind: v.kind }, 'role refused a tool call')
      return { allow: false, reason: refusalMessage(call.scope.role, v, call.scope.taskId) }
    }
  }
  try {
    // A role-scoped job runs unattended with a restriction the owner chose, so
    // the guard's rules are enforced there whatever TOOL_GUARD says. Chat keeps
    // TOOL_GUARD's mode (log by default while it is measured).
    const mode = call.scope?.role ? 'enforce' : parseGuardMode(TOOL_GUARD)
    const g = getToolGuard(mode, STORE_DIR).check({ session: call.session, tool: call.tool, input: call.input })
    if (g.entry) logger.warn({ tool: call.tool, rule: g.entry.rule, enforced: g.entry.enforced }, 'tool guard hit')
    if (!g.allow) return { allow: false, reason: g.reason ?? 'Blocked by the tool guard.' }
  } catch (err) {
    logger.warn({ err: String(err) }, 'tool guard failed open')
  }
  return { allow: true }
}

/**
 * What a scoped run is given: the built-in tools its role names, and only the
 * project's MCP servers the role may use. `servers` is null for no scope or a
 * role with every tool, meaning "leave the MCP setup alone".
 */
export function exposureForScope(scope: RunScope | undefined, cwd: string): { builtins: string[] | null; hiddenServers: string[]; servers: Record<string, unknown> | null } {
  const role = resolveRole(scope)
  if (!role || role.tools.includes('*')) return { builtins: null, hiddenServers: [], servers: null }
  const configs = mcpServerConfigs([resolve(PROJECT_ROOT, '.mcp.json'), resolve(cwd, '.mcp.json')])
  return { ...exposureFor(role, Object.keys(configs)), servers: allowedServers(role, configs) }
}
