/**
 * The false-refusal check before chat moves to TOOL_GUARD=enforce (card #233).
 * Run on the install itself, as the user the assistant runs as:
 *
 *   npm run guard-replay [-- --days 30] [--file /path/to/audit.jsonl]
 *
 * Replays the shell commands in the audit log through the network-write
 * check and prints what enforce mode would refuse, by destination host. It
 * reads the audit log and the task list and changes nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_DIR, ROLES_FILE } from '../src/config.js'
import { resolveAuditDir } from '../src/assurance/audit-trail.js'
import { formatReplay, replayAudit } from '../src/assurance/guard-replay.js'
import { netRefusal } from '../src/assurance/scope-gate.js'
import { loadRoles } from '../src/assurance/roles.js'
import { getTask, initDatabase } from '../src/db.js'
import type { AuditEvent } from '../src/assurance/audit-log.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const days = flag('days') ? Number(flag('days')) : null
const dir = resolveAuditDir(AUDIT_DIR)
const file = flag('file') ?? (dir ? join(dir, 'audit.jsonl') : null)
if (!file) {
  console.error('No audit log: this install has none (AUDIT_DIR is unset). Pass --file to read one.')
  process.exit(2)
}
let events: AuditEvent[]
try {
  events = readFileSync(file, 'utf-8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as AuditEvent] } catch { return [] }
  })
} catch (err) {
  console.error(`Could not read ${file}: ${String(err)}`)
  process.exit(2)
}
initDatabase()
const roles = loadRoles(ROLES_FILE)
const report = replayAudit(events, {
  refusalFor: (role) => netRefusal(role),
  roleOfTask: (id) => {
    const role = getTask(id)?.role
    return role ? roles.get(role) : undefined
  },
  sinceMs: days ? Date.now() - days * 86_400_000 : undefined,
})
console.log(formatReplay(report, days))
