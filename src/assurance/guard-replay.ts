/**
 * The false-refusal check before chat moves from log to enforce (card #233).
 *
 * Replays the shell commands an install actually ran, from its audit log,
 * through the network-write check as it is now, and reports what enforce
 * mode would have refused. Each hit is a real catch or a false refusal; the
 * owner reads the list and adds the hosts that are legitimate to EGRESS_ALLOW
 * before turning enforce on.
 *
 * The audit log keeps the command for a shell call and only argument names
 * for MCP tools, so browser scripts are not in the replay. Commands longer
 * than the audit detail limit are cut and may parse short.
 */
import type { AuditEvent } from './audit-log.js'
import { netWrites, type NetWrite } from './net-intent.js'
import type { RoleSpec } from './roles.js'

export type ReplayHit = { at: string; actor: string; role: string | null; rule: string; why: string; write: NetWrite; command: string }

export type ReplayReport = {
  /** Shell calls replayed. */
  calls: number
  /** Of those, calls that send or change something over the network. */
  writes: number
  hits: ReplayHit[]
  /** Refused writes per destination host, most first. */
  byHost: Array<[string, number]>
}

const SHELL = new Set(['Bash', 'bash'])
// Notes the gate appends to a detail: " :: tool guard ...", " :: role ...", " :: effect journal ...".
const NOTE = / :: (?:tool guard|role |effect journal|grant revoked|egress)[^]*$/

/** The command an audit detail recorded, or null when it is not a shell call. */
export function commandOf(e: Pick<AuditEvent, 'action' | 'detail'>): string | null {
  if (!SHELL.has(e.action) || !e.detail) return null
  const body = e.detail.replace(/^\S+ /, '')
  return body.replace(NOTE, '')
}

export function replayAudit(
  events: AuditEvent[],
  opts: {
    refusalFor: (role: RoleSpec | undefined) => ((w: NetWrite) => { rule: string; why: string } | null) | null
    roleOfTask: (taskId: string) => RoleSpec | undefined
    sinceMs?: number
  },
): ReplayReport {
  const report: ReplayReport = { calls: 0, writes: 0, hits: [], byHost: [] }
  const hosts = new Map<string, number>()
  for (const e of events) {
    if (opts.sinceMs && Date.parse(e.ts) < opts.sinceMs) continue
    const command = commandOf(e)
    if (command === null) continue
    report.calls++
    const writes = netWrites('Bash', { command })
    if (!writes.length) continue
    report.writes++
    const task = /^job:(.+)$/.exec(e.actor ?? '')?.[1]
    const role = task ? opts.roleOfTask(task) : undefined
    const refuse = opts.refusalFor(role)
    if (!refuse) continue
    for (const w of writes) {
      const bad = refuse(w)
      if (!bad) continue
      report.hits.push({ at: e.ts, actor: e.actor, role: role?.id ?? null, rule: bad.rule, why: bad.why, write: w, command: command.slice(0, 160) })
      const h = w.host ?? '(not written out)'
      hosts.set(h, (hosts.get(h) ?? 0) + 1)
      break
    }
  }
  report.byHost = [...hosts.entries()].sort((a, b) => b[1] - a[1])
  return report
}

export function formatReplay(r: ReplayReport, days: number | null): string {
  const span = days ? `the last ${days} day${days === 1 ? '' : 's'}` : 'the whole audit log'
  const lines = [`Replayed ${r.calls} shell call${r.calls === 1 ? '' : 's'} from ${span}. ${r.writes} sent or changed something over the network.`]
  if (!r.hits.length) {
    lines.push('None would be refused by the network-write check. Nothing here stands in the way of TOOL_GUARD=enforce.')
    return lines.join('\n')
  }
  lines.push(`${r.hits.length} would be refused in enforce mode. By destination:`)
  for (const [host, n] of r.byHost) lines.push(`  ${host}: ${n}`)
  lines.push('', 'Most recent:')
  for (const h of r.hits.slice(-10).reverse()) {
    lines.push(`  ${h.at.slice(0, 16).replace('T', ' ')} ${h.actor}${h.role ? ` (${h.role})` : ''} [${h.rule}] ${h.write.method} ${h.write.host ?? '?'}: ${h.command.slice(0, 90)}`)
  }
  lines.push('', 'For each host: if it is a service the owner uses on purpose, add it to EGRESS_ALLOW. Anything left is what enforce mode would stop.')
  return lines.join('\n')
}
