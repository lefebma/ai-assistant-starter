/**
 * SPACE execution adapter (spike #225). A prototype, not wired into a runtime.
 *
 * Question: if shell commands run in a SPACE Firecracker sandbox instead of
 * on the box, do Havn's externally enforced permissions still hold, and does
 * isolation improve? This file is the route that answers it. It plugs into
 * the #218 harness (containment-eval.ts) through Harness.execute, so the same
 * cases, the same gate (scope-gate.ts: audit guard, role, tool guard) and the
 * same audit log run in front of it. Nothing here replaces those layers:
 *
 *   gateToolCall  ->  allowed?  ->  SpaceRoute.execute  ->  guest
 *   (unchanged)                     host-side audit before dispatch and
 *                                   after the exit result
 *
 * What the route adds:
 *   - one sandbox per run (session), created on first use and deleted at the
 *     end, so nothing carries over between runs;
 *   - a default-deny egress policy per role, enforced by SPACE's gateway, not
 *     by the agent's process. An expired grant gets a deny-all policy;
 *   - revocation: a live sandbox's policy can be replaced with deny-all.
 *
 * What it does not do: credentials never go into the guest, and the audit
 * record is written on the host, because SPACE streams have no replay.
 * Mail, calendar and other host tools stay on the box.
 *
 * Token handling follows SPACE's own rules: management token for the API,
 * the per-command attachment token for the data plane, never one for the
 * other, no redirects followed with either, plain HTTP only to loopback or a
 * private lab address.
 */
import { randomUUID } from 'node:crypto'
import type { AuditLog } from './audit-log.js'
import { getAuditTrail } from './audit-trail.js'
import { AUDIT_DIR, PROJECT_ROOT } from '../config.js'
import { fetchCalls, type Effect, type ExecResult, type GateCall } from './containment-eval.js'

// --- policy -------------------------------------------------------------------

export type Destination = { ip: string } | { cidr: string } | { domain: string }

/** The subset of SPACE's NetworkPolicyV1 this adapter writes. */
export interface NetworkPolicy {
  version: 'v1'
  egress: { default_action: 'allow' | 'deny'; allow: Destination[]; deny: Destination[] }
}

export const DENY_ALL: NetworkPolicy = { version: 'v1', egress: { default_action: 'deny', allow: [], deny: [] } }

export function policyFor(allow: Destination[], deny: Destination[] = []): NetworkPolicy {
  return { version: 'v1', egress: { default_action: 'deny', allow, deny } }
}

/** What a role may reach. SPACE rules are address or exact domain only: no port, no method, no path. */
export interface Grant {
  allow: Destination[]
  /** ISO time. After it the run gets DENY_ALL. roles.json has no such field (#218 defect 4). */
  expiresAt?: string
}

// --- the API ------------------------------------------------------------------

export interface ExecOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  /** Stream ended without process_exited, or the stream reported an error. */
  error?: string
  sessionId?: string
  ms: number
}

export interface SpaceApi {
  createSandbox(req: { policy: NetworkPolicy; name: string; metadata?: Record<string, string> }): Promise<{ sandboxId: string; ms: number }>
  run(sandboxId: string, argv: string[], opts?: { timeout?: string; env?: Record<string, string>; idempotencyKey?: string }): Promise<ExecOutcome>
  setPolicy(sandboxId: string, policy: NetworkPolicy): Promise<void>
  deleteSandbox(sandboxId: string): Promise<void>
}

export class SpaceApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) { super(message) }
}

/** Plain HTTP is allowed only to loopback and private lab addresses. */
export function checkOrigin(url: string): string {
  const u = new URL(url)
  if (u.protocol === 'https:') return u.origin
  const h = u.hostname
  const lab = h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  if (u.protocol === 'http:' && lab) return u.origin
  throw new SpaceApiError(`refusing ${u.protocol}//${h}: use HTTPS except for loopback or a private lab address`)
}

export type SseFrame = Record<string, unknown> & { type?: string }

/** Parse an SSE body into its JSON data frames; event/id fields and comments are ignored. */
export function sseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  let data: string[] = []
  const flush = () => {
    if (data.length) frames.push(JSON.parse(data.join('\n')) as SseFrame)
    data = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') { flush(); continue }
    const i = line.indexOf(':')
    const field = i < 0 ? line : line.slice(0, i)
    if (field === 'data') data.push(line.slice(i + 1).replace(/^ /, ''))
  }
  if (data.length) throw new SpaceApiError('stream ended in an incomplete SSE frame')
  return frames
}

export function outcomeOf(frames: SseFrame[], ms: number, sessionId?: string): ExecOutcome {
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let error: string | undefined
  for (const f of frames) {
    if (f.type === 'stdout' || f.type === 'stderr') {
      const s = Buffer.from(String(f.data_base64 ?? ''), 'base64').toString('utf-8')
      if (f.type === 'stdout') stdout += s
      else stderr += s
    } else if (f.type === 'process_exited') exitCode = typeof f.exit_code === 'number' ? f.exit_code : null
    else if (f.type === 'error' || f.type === 'resync_required') error = f.type
  }
  if (exitCode === null && !error) error = 'stream ended without process_exited'
  return { exitCode, stdout, stderr, error, sessionId, ms }
}

const POLL_MS = 250

export interface HttpSpaceOptions {
  apiUrl: string
  dataPlaneUrl: string
  token: string
  template?: string
  /** Longest wait for one operation or command stream. */
  timeoutMs?: number
}

/** The supported SPACE HTTP API (create, poll, commands, events, delete). */
export class HttpSpaceApi implements SpaceApi {
  readonly api: string
  readonly dataPlane: string
  private readonly template: string
  private readonly timeoutMs: number

  constructor(private readonly opts: HttpSpaceOptions) {
    this.api = checkOrigin(opts.apiUrl)
    this.dataPlane = checkOrigin(opts.dataPlaneUrl)
    this.template = opts.template ?? 'seed:latest'
    this.timeoutMs = opts.timeoutMs ?? 120_000
  }

  /** One request. Never follows a redirect, whichever token it carries. */
  async request(method: string, path: string, init: { token?: string; body?: unknown; key?: string; base?: 'api' | 'data'; accept?: string } = {}): Promise<{ status: number; text: string }> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new SpaceApiError(`expected a path, got ${path}`)
    const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' }
    const token = init.token ?? this.opts.token
    if (token) headers.Authorization = `Bearer ${token}`
    if (init.key) headers['Idempotency-Key'] = init.key
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch((init.base === 'data' ? this.dataPlane : this.api) + path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    if (res.status >= 300 && res.status < 400) throw new SpaceApiError(`${method} ${path}: refusing to follow a ${res.status} redirect`, res.status)
    return { status: res.status, text }
  }

  private async json(method: string, path: string, init: { body?: unknown; key?: string } = {}): Promise<Record<string, unknown>> {
    const r = await this.request(method, path, init)
    if (r.status >= 400) throw new SpaceApiError(`${method} ${path}: HTTP ${r.status}`, r.status, r.text.slice(0, 500))
    return r.text ? JSON.parse(r.text) as Record<string, unknown> : {}
  }

  private async waitFor(path: string, target: string): Promise<Record<string, unknown>> {
    const end = Date.now() + this.timeoutMs
    for (;;) {
      const r = await this.json('GET', path)
      if (r.state === target) return r
      if (['failed', 'canceled', 'expired', 'deleted', 'stopped'].includes(String(r.state))) {
        throw new SpaceApiError(`${path} is ${String(r.state)}, expected ${target}`, undefined, JSON.stringify(r).slice(0, 500))
      }
      if (Date.now() > end) throw new SpaceApiError(`timed out waiting for ${path} to be ${target}`)
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }

  private async operation(r: Record<string, unknown>): Promise<void> {
    const op = r.operation_id
    if (typeof op === 'string' && op) await this.waitFor(`/v1/operations/${op}`, 'succeeded')
  }

  async createSandbox(req: { policy: NetworkPolicy; name: string; metadata?: Record<string, string> }): Promise<{ sandboxId: string; ms: number }> {
    const t0 = Date.now()
    const r = await this.json('POST', '/v1/sandboxes', {
      body: { template: this.template, runtime: 'fc', name: req.name, metadata: req.metadata ?? {}, network_policy: req.policy },
      key: `havn-create-${randomUUID()}`,
    })
    const id = r.sandbox_id
    if (typeof id !== 'string' || !/^sbx_[A-Za-z0-9_-]+$/.test(id)) throw new SpaceApiError('create returned no sandbox id', undefined, JSON.stringify(r).slice(0, 300))
    await this.operation(r)
    await this.waitFor(`/v1/sandboxes/${id}`, 'running')
    await this.json('GET', `/v1/sandboxes/${id}/processes?limit=1`)
    return { sandboxId: id, ms: Date.now() - t0 }
  }

  /** Create a command and attach to it. Returns the handle so token probes can reuse it. */
  async startCommand(sandboxId: string, argv: string[], opts: { timeout?: string; env?: Record<string, string>; idempotencyKey?: string } = {}): Promise<{ sessionId: string; eventsPath: string; token: string; status: number; raw: Record<string, unknown> }> {
    const r = await this.request('POST', `/v1/sandboxes/${sandboxId}/commands`, {
      body: { command: argv, timeout: opts.timeout ?? '30s', ...(opts.env ? { env: opts.env } : {}) },
      key: opts.idempotencyKey ?? `havn-cmd-${randomUUID()}`,
    })
    if (r.status >= 400) throw new SpaceApiError(`command create: HTTP ${r.status}`, r.status, r.text.slice(0, 500))
    const raw = JSON.parse(r.text) as Record<string, unknown>
    const sessionId = String(raw.session_id ?? '')
    const attach = (raw.attach ?? {}) as { events_url?: string; token?: string }
    const eventsPath = `/v1/sessions/${sessionId}/events`
    // Accept the events URL only at the data-plane origin and this exact session path.
    if (!/^proc_[A-Za-z0-9_-]+$/.test(sessionId) || ![eventsPath, this.dataPlane + eventsPath].includes(String(attach.events_url))) {
      throw new SpaceApiError(`unexpected events URL ${String(attach.events_url)}; not following it`)
    }
    if (!attach.token) throw new SpaceApiError('command attachment token is missing')
    return { sessionId, eventsPath, token: attach.token, status: r.status, raw }
  }

  async attach(eventsPath: string, token: string): Promise<{ status: number; frames: SseFrame[]; text: string }> {
    const r = await this.request('GET', eventsPath, { token, base: 'data', accept: 'text/event-stream' })
    return { status: r.status, frames: r.status < 400 ? sseFrames(r.text) : [], text: r.text }
  }

  async run(sandboxId: string, argv: string[], opts: { timeout?: string; env?: Record<string, string>; idempotencyKey?: string } = {}): Promise<ExecOutcome> {
    const t0 = Date.now()
    const c = await this.startCommand(sandboxId, argv, opts)
    const a = await this.attach(c.eventsPath, c.token)
    if (a.status >= 400) throw new SpaceApiError(`attach: HTTP ${a.status}`, a.status, a.text.slice(0, 300))
    return outcomeOf(a.frames, Date.now() - t0, c.sessionId)
  }

  async setPolicy(sandboxId: string, policy: NetworkPolicy): Promise<void> {
    const r = await this.json('PATCH', `/v1/sandboxes/${sandboxId}`, { body: { network_policy: { mode: 'set', policy } }, key: `havn-policy-${randomUUID()}` })
    await this.operation(r)
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const r = await this.json('DELETE', `/v1/sandboxes/${sandboxId}`, { key: `havn-delete-${randomUUID()}` })
    await this.operation(r)
  }
}

// --- the execution route ------------------------------------------------------

/** Exit codes that mean the request never reached a destination (curl, then wget's 4). */
const NET_FAIL = new Set([6, 7, 28, 35, 52, 56])

function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** The guest command for a call, or null when the call stays on the host. */
export function guestCommand(tool: string, input: Record<string, unknown>, networkTools: boolean): string | null {
  if (tool === 'Bash') return String(input.command ?? '')
  if (!networkTools) return null
  if (tool === 'WebFetch' || tool === 'mcp__playwright__browser_navigate') return `curl -sS -L -m 10 ${q(String(input.url ?? ''))}`
  if (tool === 'mcp__playwright__browser_evaluate' || tool === 'mcp__playwright__browser_run_code') {
    const calls = fetchCalls(String(input.function ?? input.code ?? ''))
    if (!calls.length) return null
    return calls.map((r) => `curl -sS -L -m 10 -X ${r.method}${r.body !== undefined ? ` --data ${q(r.body)}` : ''} ${q(r.url)}`).join('; ')
  }
  return null
}

export interface SpaceRouteOptions {
  api: SpaceApi
  /** The egress a run may have, from its role, or from "chat" for an unscoped run. */
  grantFor(roleOrChat: string): Grant
  /** Also run WebFetch and browser fetches in the guest (as curl). Off: only Bash moves. */
  networkTools?: boolean
  /**
   * The independent log, for host-side dispatch and exit records. Defaults to
   * the gate's shared trail. It must be the same AuditLog instance the gate
   * writes through: a second instance on the same file keeps its own sequence
   * and hash head, and interleaved appends break the chain.
   */
  audit?: () => AuditLog | null
  now?: () => Date
  timeout?: string
}

export type RouteMetrics = { creates: number[]; commands: number[]; failures: string[] }

/** Runs allowed calls in one SPACE sandbox per run. Plugs into Harness.execute. */
export class SpaceRoute {
  readonly sandboxes = new Map<string, { id: string; policy: NetworkPolicy }>()
  readonly metrics: RouteMetrics = { creates: [], commands: [], failures: [] }
  readonly dispatched: { session: string; sandboxId: string; command: string; exitCode: number | null }[] = []

  constructor(private readonly opts: SpaceRouteOptions) {}

  /** The policy a run gets: its grant, or deny-all once the grant has expired. */
  policyFor(roleOrChat: string): NetworkPolicy {
    const g = this.opts.grantFor(roleOrChat)
    const now = (this.opts.now ?? (() => new Date()))()
    if (g.expiresAt && Date.parse(g.expiresAt) <= now.getTime()) return DENY_ALL
    return policyFor(g.allow)
  }

  private async sandboxFor(call: GateCall): Promise<string> {
    const have = this.sandboxes.get(call.session)
    if (have) return have.id
    const who = call.scope?.role ?? 'chat'
    const policy = this.policyFor(who)
    const name = `havn-${call.session.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 60)
    const { sandboxId, ms } = await this.opts.api.createSandbox({ policy, name, metadata: { havn_run: call.session, havn_role: who } })
    this.metrics.creates.push(ms)
    this.sandboxes.set(call.session, { id: sandboxId, policy })
    return sandboxId
  }

  private record(session: string, action: string, detail: string): void {
    try {
      const log = this.opts.audit ? this.opts.audit() : getAuditTrail(AUDIT_DIR, PROJECT_ROOT)?.log
      log?.append({ runId: session, actor: 'space-route', action, outcome: 'allowed', detail: detail.slice(0, 500) })
    } catch {
      // Recording never decides the outcome, as in audit-trail.ts.
    }
  }

  async execute(call: GateCall, _effects: Effect[]): Promise<ExecResult | null> {
    const command = guestCommand(call.tool, (call.input ?? {}) as Record<string, unknown>, this.opts.networkTools ?? false)
    if (command === null) return null
    let sandboxId: string
    try {
      sandboxId = await this.sandboxFor(call)
    } catch (err) {
      // Fail closed: no sandbox means the command does not run anywhere.
      this.metrics.failures.push(`create: ${String(err).slice(0, 200)}`)
      this.record(call.session, 'space.create-failed', String(err))
      return { output: `space: sandbox unavailable, not run (${String(err).slice(0, 120)})` }
    }
    this.record(call.session, 'space.dispatch', `${call.tool} sbx=${sandboxId}`)
    let out: ExecOutcome
    try {
      out = await this.opts.api.run(sandboxId, ['sh', '-c', command], { timeout: this.opts.timeout ?? '20s' })
    } catch (err) {
      this.metrics.failures.push(`run: ${String(err).slice(0, 200)}`)
      this.record(call.session, 'space.exit', `sbx=${sandboxId} error=${String(err).slice(0, 200)}`)
      return { output: `space: command failed (${String(err).slice(0, 120)})` }
    }
    this.metrics.commands.push(out.ms)
    this.dispatched.push({ session: call.session, sandboxId, command, exitCode: out.exitCode })
    this.record(call.session, 'space.exit', `sbx=${sandboxId} exit=${out.exitCode ?? 'none'}${out.error ? ` error=${out.error}` : ''}`)
    const output = `${out.stdout}${out.stderr}`.slice(0, 2000)
    // A refused connection is the gateway's work only when the destination saw nothing; the harness checks that.
    const denied = out.exitCode !== null && NET_FAIL.has(out.exitCode) ? ` egress denied (guest exit ${out.exitCode})` : ''
    return { output: output + denied }
  }

  /** Replace a live run's policy with deny-all: revocation at the gateway. */
  async revoke(session: string): Promise<boolean> {
    const s = this.sandboxes.get(session)
    if (!s) return false
    await this.opts.api.setPolicy(s.id, DENY_ALL)
    s.policy = DENY_ALL
    this.record(session, 'space.revoke', `sbx=${s.id}`)
    return true
  }

  /** Delete every sandbox this route created. Returns the ids it could not delete. */
  async dispose(): Promise<string[]> {
    const left: string[] = []
    for (const [session, s] of this.sandboxes) {
      try {
        await this.opts.api.deleteSandbox(s.id)
        this.sandboxes.delete(session)
      } catch {
        left.push(s.id)
      }
    }
    return left
  }
}
