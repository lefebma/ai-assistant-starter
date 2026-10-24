/**
 * Egress for a run (card #231): which policy applies, a proxy for the run's
 * tools, and the env that points them at it.
 *
 * runAgent opens one proxy per turn when EGRESS=enforce. The policy is read
 * per connection from the live grant (#230) when there is one, so a job the
 * owner pauses loses its network with its tools, and a role change applies
 * to the next connection. Chat gets the chat policy.
 *
 * What reaches the proxy: curl, wget, gog, python, Claude Code itself
 * (WebFetch and the AI calls), Node scripts (NODE_USE_ENV_PROXY) and the
 * browser (the Playwright launcher passes --proxy-server). On a machine
 * without the kernel rule this is best effort: a command that ignores the
 * proxy settings still goes out directly. A hosted box closes that gap
 * (EGRESS_CGROUP, see hosted.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { EGRESS, EGRESS_ALLOW, EGRESS_PORTS, EGRESS_READ, PROJECT_ROOT, AUDIT_DIR, ROLES_FILE } from '../config.js'
import { logger } from '../logger.js'
import { getAuditTrail, currentActor } from '../assurance/audit-trail.js'
import { loadRoles, roleExpired, type RoleSpec } from '../assurance/roles.js'
import { currentGrant } from '../assurance/grant.js'
import { currentRun } from '../assurance/effect-journal.js'
import { listAccounts } from '../imap/store.js'
import { ESSENTIALS, expandRules, listFromEnv, type EgressPolicy, type GroupSources } from './policy.js'
import { openRunProxy, type EgressRecord, type RunProxy } from './proxy.js'

export type EgressConfig = { approved: string[]; read: string[]; imapHosts: () => string[] }

function imapHosts(): string[] {
  try {
    return listAccounts().flatMap((a) => [`${a.imap.host}:${a.imap.port}`, `${a.smtp.host}:${a.smtp.port}`])
  } catch {
    return []
  }
}

export function egressConfig(): EgressConfig {
  return { approved: listFromEnv(EGRESS_ALLOW), read: listFromEnv(EGRESS_READ), imapHosts }
}

const sources = (cfg: EgressConfig): GroupSources => ({ approved: cfg.approved, readList: cfg.read, imapHosts: cfg.imapHosts })

export function chatPolicy(cfg: EgressConfig = egressConfig()): EgressPolicy {
  return {
    name: 'chat',
    write: expandRules([...ESSENTIALS, '@google', '@microsoft', '@imap', '@slack', '@approved'], sources(cfg)),
    read: expandRules(['@read'], sources(cfg)),
  }
}

/** Essentials only: what a run may reach when nothing else is granted. */
export function essentialsPolicy(name: string): EgressPolicy {
  return { name, write: expandRules(ESSENTIALS), read: [] }
}

export function rolePolicy(role: RoleSpec, cfg: EgressConfig = egressConfig()): EgressPolicy {
  if (roleExpired(role)) return { name: `the ${role.id} role`, write: [], read: [] }
  if (!role.egress && role.tools.includes('*')) return { ...chatPolicy(cfg), name: `the ${role.id} role` }
  return {
    name: `the ${role.id} role`,
    write: expandRules([...ESSENTIALS, ...(role.egress?.write ?? [])], sources(cfg)),
    read: expandRules(role.egress?.read ?? [], sources(cfg)),
  }
}

/** The policy for a role id, or chat for none. An unknown role reaches only the AI. */
export function policyFor(roleId: string | null | undefined, cfg: EgressConfig = egressConfig(), roles: Map<string, RoleSpec> = loadRoles(ROLES_FILE)): EgressPolicy {
  if (!roleId) return chatPolicy(cfg)
  const role = roles.get(roleId)
  return role ? rolePolicy(role, cfg) : essentialsPolicy(`the undefined ${roleId} role`)
}

/** Nothing may leave: a revoked grant. */
const NOTHING = (reason: string): EgressPolicy => ({ name: `this run (${reason})`, write: [], read: [] })

export function parsePorts(v: string): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(v.trim())
  if (!m) return undefined
  const lo = Number(m[1]), hi = Number(m[2])
  return lo > 1023 && hi >= lo && hi < 65536 ? [lo, hi] : undefined
}

// --- the run's proxy ---------------------------------------------------------

const proxyStore = new AsyncLocalStorage<RunProxy>()

/** The proxy URL in force for this run, if egress is on. */
export function currentProxy(): string | undefined {
  return proxyStore.getStore()?.url
}

/** Env that sends a tool's traffic through the run's proxy. Empty when there is none. */
export function proxyEnv(url: string | undefined = currentProxy()): Record<string, string> {
  if (!url) return {}
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url,
    // Nothing is exempt: on a hosted box the kernel would drop it anyway.
    NO_PROXY: '', no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
    // Claude Code's own telemetry and update checks would only be refused.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

/** A `record` for openRunProxy that writes to the audit log under this run. */
export function auditEgress(runId: string, actor: string): (r: EgressRecord) => void {
  return (r) => audit(runId, actor, r)
}

function audit(runId: string, actor: string, r: EgressRecord): void {
  try {
    getAuditTrail(AUDIT_DIR, PROJECT_ROOT)?.log.append({
      runId, actor, action: 'egress', outcome: r.decision === 'allowed' ? 'allowed' : 'blocked',
      detail: `${r.method} ${r.host}:${r.port}${r.path}${r.reason ? ` :: ${r.reason}` : ''}`.slice(0, 500),
    })
  } catch {
    // Recording never decides the outcome.
  }
  if (r.decision === 'denied') logger.warn({ run: runId, host: r.host, port: r.port, method: r.method, reason: r.reason }, 'egress denied')
}

let shared: Promise<RunProxy> | null = null

/**
 * One long-lived proxy with the chat policy, for processes that outlive a run
 * (the ai-sdk runtime's MCP servers start once and serve every run). Their
 * traffic is held to chat's allowlist, not a job's role: a known limit.
 */
export function sharedChatProxy(): Promise<RunProxy> {
  shared ??= openRunProxy({ policy: () => chatPolicy(), ports: parsePorts(EGRESS_PORTS), record: (r) => audit('shared-mcp', 'ai-sdk-mcp', r) })
  shared.catch(() => { shared = null })
  return shared
}

export type EgressOptions = { roleId?: string | null; enforce?: boolean; cfg?: EgressConfig; record?: (r: EgressRecord) => void }

/**
 * Run `fn` with its own egress proxy. The policy follows the live grant when
 * there is one (a scheduled job), else `roleId`, else chat. With egress off
 * this is just `fn()`.
 */
export async function withEgress<T>(opts: EgressOptions, fn: () => Promise<T>): Promise<T> {
  if (!(opts.enforce ?? EGRESS === 'enforce') || proxyStore.getStore()) return fn()
  const startRole = opts.roleId ?? null
  const runId = currentRun() ?? 'unattributed'
  const actor = currentActor()
  // The proxy's callbacks run outside this context: bind the grant check to it now.
  const live = currentGrant() ? AsyncLocalStorage.bind(() => currentGrant()) : null
  const policy = (): EgressPolicy => {
    const g = live ? live() : null
    if (g && !g.ok) return NOTHING(g.reason)
    return policyFor(g ? g.role : startRole, opts.cfg)
  }
  let proxy: RunProxy
  try {
    proxy = await openRunProxy({ policy, ports: parsePorts(EGRESS_PORTS), record: opts.record ?? ((r) => audit(runId, actor, r)) })
  } catch (err) {
    // Fail closed: a run that cannot get its proxy does not run with an open network.
    logger.error({ err: String(err) }, 'egress proxy could not start; run refused')
    throw new Error(`Egress is enforced but the proxy could not start (${String(err)}).`)
  }
  try {
    return await proxyStore.run(proxy, fn)
  } finally {
    await proxy.close()
  }
}
