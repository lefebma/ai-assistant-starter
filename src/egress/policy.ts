/**
 * Where tool and shell traffic may go (card #231, from spike #218 defect 1).
 *
 * Default deny. A run's policy is two host lists:
 *   - write: any request, any method (and an HTTPS tunnel)
 *   - read:  GET, HEAD and OPTIONS over plain HTTP; an HTTPS tunnel too,
 *            because a proxy that does not decrypt cannot see the method
 *            inside it. "Read" is therefore enforced on plain HTTP only.
 *
 * Who gets what:
 *   - chat: the essentials, every service the box is set up for, the box's
 *     approved hosts (EGRESS_ALLOW) for writing and its read list (EGRESS_READ)
 *   - a scheduled job with a role: the essentials plus the role's own lists
 *     (RoleSpec.egress). A role with none reaches only the essentials.
 *
 * Entries are a host ("example.com"), a host and port ("example.com:8443"),
 * a wildcard ("*.example.com", subdomains only) or a group ("@google").
 * A host without a port means 80 and 443. An address on loopback, a private
 * range or link-local (cloud metadata) is refused unless it is listed as that
 * exact address: a public name that resolves to one is refused too (proxy.ts).
 */
import { isIP } from 'node:net'

export type HostRule = { host: string; wildcard: boolean; port?: number }
export type EgressPolicy = { name: string; write: HostRule[]; read: HostRule[] }
export type EgressRequest = { host: string; port: number; /** null for an HTTPS tunnel, where the method cannot be seen. */ method: string | null }
export type EgressDecision = { allow: true; via: 'write' | 'read' } | { allow: false; reason: string }

/** The AI itself. Always reachable, or the run could not think. */
export const ESSENTIALS = ['api.anthropic.com']

/** Hosts a service's commands need. IMAP is filled from the box's accounts. */
export const SERVICE_GROUPS: Record<string, string[]> = {
  anthropic: ESSENTIALS,
  google: ['gmail.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com'],
  microsoft: ['graph.microsoft.com', 'login.microsoftonline.com'],
  slack: ['slack.com', '*.slack.com'],
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function parseRule(entry: string): HostRule | null {
  let s = entry.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')
  let port: number | undefined
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (bracket) {
    s = bracket[1]
    if (bracket[2]) port = Number(bracket[2])
  } else {
    const m = /^([^:]+):(\d+)$/.exec(s)
    if (m) { s = m[1]; port = Number(m[2]) }
  }
  if (port !== undefined && !(port > 0 && port < 65536)) return null
  const wildcard = s.startsWith('*.')
  const host = wildcard ? s.slice(2) : s
  if (!host || /[^a-z0-9.\-:]/.test(host)) return null
  return { host, wildcard, ...(port ? { port } : {}) }
}

export type GroupSources = { imapHosts?: () => string[]; approved?: string[]; readList?: string[] }

/** Expands @groups and parses every entry. Unknown groups and bad entries are dropped. */
export function expandRules(entries: string[], src: GroupSources = {}): HostRule[] {
  const out: HostRule[] = []
  for (const e of entries) {
    const t = e.trim()
    if (t.startsWith('@')) {
      const g = t.slice(1).toLowerCase()
      const hosts = g === 'imap' ? src.imapHosts?.() ?? []
        : g === 'approved' ? src.approved ?? []
        : g === 'read' ? src.readList ?? []
        : SERVICE_GROUPS[g] ?? []
      out.push(...hosts.map(parseRule).filter((r): r is HostRule => r !== null))
      continue
    }
    const r = parseRule(t)
    if (r) out.push(r)
  }
  return out
}

function matches(rule: HostRule, host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const hostOk = rule.wildcard ? h.endsWith(`.${rule.host}`) : h === rule.host
  if (!hostOk) return false
  return rule.port !== undefined ? port === rule.port : port === 80 || port === 443
}

/** Loopback, private, CGNAT, link-local (cloud metadata) and unspecified addresses. */
export function isInternalAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').toLowerCase()
  const v4 = isIP(a) === 4 ? a : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1]
  if (v4) {
    const [x, y] = v4.split('.').map(Number)
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y < 128) || (x === 169 && y === 254)
      || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168)
  }
  if (isIP(a) === 6) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)
  return false
}

/** Is this rule the exact address (an internal address must be listed as itself). */
function literalRule(rule: HostRule, host: string): boolean {
  return !rule.wildcard && rule.host === host.toLowerCase().replace(/^\[|\]$/g, '')
}

export function decide(policy: EgressPolicy, req: EgressRequest): EgressDecision {
  const host = req.host.toLowerCase()
  const internal = isIP(host.replace(/^\[|\]$/g, '')) !== 0 && isInternalAddress(host)
  const find = (rules: HostRule[]) => rules.find((r) => matches(r, host, req.port) && (!internal || literalRule(r, host)))
  if (find(policy.write)) return { allow: true, via: 'write' }
  if (find(policy.read)) {
    if (req.method === null || READ_METHODS.has(req.method.toUpperCase())) return { allow: true, via: 'read' }
    return { allow: false, reason: `${policy.name} may only read from ${host}:${req.port}, not ${req.method.toUpperCase()}` }
  }
  return { allow: false, reason: `${host}:${req.port} is not on ${policy.name}'s allowlist` }
}

/** A hosts list from .env: comma or whitespace separated. */
export function listFromEnv(v: string | undefined): string[] {
  return (v ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}
