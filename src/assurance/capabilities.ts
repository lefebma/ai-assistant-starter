/**
 * Role-scoped MCP capability delivery (card 171).
 *
 * A run starts with a minimal catalog of the roles it may adopt and NO tools.
 * Tools are delivered only after an authorized role is selected. Every call is
 * checked here, outside the model: unknown tool, wrong role, or a parameter
 * outside the role's declared limits is refused and the executor never runs.
 * Switching roles mid-run is a governed transition: the model may request it,
 * only the harness (approveTransition) can grant it, and only to roles the run
 * was authorized for at start.
 *
 * Failures are classified separately so tool-selection quality (the model
 * reaching for a tool that does not exist) is not mixed up with authorization
 * (the model reaching for a real tool it may not have).
 *
 * Prototype: broker logic only. Wiring means building the MCP tool set from
 * deliveredTools() and routing each tool execute() through invoke().
 */

export type ParamSpec =
  | { type: 'string'; maxLength?: number; oneOf?: string[]; pattern?: RegExp }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'boolean' }

export type ToolDef = { params?: Record<string, ParamSpec>; required?: string[] }
export type RoleDef = { id: string; summary: string; tools: Record<string, ToolDef> }

export type FailureKind = 'no-role' | 'discovery' | 'unauthorized' | 'param-limit'
export type InvokeResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; kind: FailureKind; reason: string }

export type CrossRoleEntry = { tool: string; requiredRole: string; currentRole: string | null; at: string }
export type Transition = { id: string; to: string; reason: string; status: 'pending' | 'approved' | 'refused' }

export type Metrics = {
  calls: number
  success: number
  discoveryFailures: number
  authorizationFailures: number
  parameterFailures: number
  noRoleFailures: number
  crossRoleRequests: number
  /** Calls that named a tool that exists in the catalog / all calls. Authorization is not counted against it. */
  selectionSuccessRate: number
}

type Run = {
  authorized: Set<string>
  role: string | null
  crossRole: CrossRoleEntry[]
  transitions: Transition[]
  m: Omit<Metrics, 'crossRoleRequests' | 'selectionSuccessRate'>
}

export function validateParams(def: ToolDef, params: Record<string, unknown>): string | null {
  const specs = def.params ?? {}
  for (const k of Object.keys(params)) if (!(k in specs)) return `parameter "${k}" is not permitted for this tool`
  for (const k of def.required ?? []) if (!(k in params)) return `parameter "${k}" is required`
  for (const [k, spec] of Object.entries(specs)) {
    if (!(k in params)) continue
    const v = params[k]
    if (spec.type === 'string') {
      if (typeof v !== 'string') return `"${k}" must be a string`
      if (spec.maxLength !== undefined && v.length > spec.maxLength) return `"${k}" exceeds ${spec.maxLength} characters`
      if (spec.oneOf && !spec.oneOf.includes(v)) return `"${k}" must be one of ${spec.oneOf.join(', ')}`
      if (spec.pattern && !spec.pattern.test(v)) return `"${k}" does not match the allowed pattern`
    } else if (spec.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${k}" must be a number`
      if (spec.max !== undefined && v > spec.max) return `"${k}" exceeds the limit of ${spec.max}`
      if (spec.min !== undefined && v < spec.min) return `"${k}" is below the minimum of ${spec.min}`
    } else if (typeof v !== 'boolean') return `"${k}" must be a boolean`
  }
  return null
}

export class CapabilityBroker {
  private roles = new Map<string, RoleDef>()
  private runs = new Map<string, Run>()
  private seq = 0

  constructor(roles: RoleDef[]) {
    for (const r of roles) this.roles.set(r.id, r)
  }

  startRun(runId: string, opts: { authorizedRoles: string[] }): void {
    this.runs.set(runId, {
      authorized: new Set(opts.authorizedRoles.filter(r => this.roles.has(r))),
      role: null, crossRole: [], transitions: [],
      m: { calls: 0, success: 0, discoveryFailures: 0, authorizationFailures: 0, parameterFailures: 0, noRoleFailures: 0 },
    })
  }

  private run(id: string): Run {
    const r = this.runs.get(id)
    if (!r) throw new Error(`unknown run ${id}`)
    return r
  }

  catalog(runId: string): { id: string; summary: string }[] {
    return [...this.run(runId).authorized].map(id => ({ id, summary: this.roles.get(id)!.summary }))
  }

  currentRole(runId: string): string | null { return this.run(runId).role }

  /** What the model is shown: names and parameter limits for the active role only. */
  deliveredTools(runId: string): { name: string; params: ToolDef['params'] }[] {
    const run = this.run(runId)
    if (!run.role) return []
    return Object.entries(this.roles.get(run.role)!.tools).map(([name, t]) => ({ name, params: t.params }))
  }

  /** First selection only. Changing role afterwards must go through a governed transition. */
  selectRole(runId: string, roleId: string): { ok: boolean; reason?: string } {
    const run = this.run(runId)
    if (run.role) return { ok: false, reason: 'a role is already active; request a governed transition' }
    if (!run.authorized.has(roleId)) return { ok: false, reason: 'role is not authorized for this run' }
    run.role = roleId
    return { ok: true }
  }

  requestTransition(runId: string, to: string, reason: string): Transition {
    const run = this.run(runId)
    const t: Transition = { id: `t${++this.seq}`, to, reason, status: 'pending' }
    run.transitions.push(t)
    return t
  }

  /** Harness-only. Refuses roles the run was never authorized for. */
  approveTransition(runId: string, transitionId: string, _approver: string): boolean {
    const run = this.run(runId)
    const t = run.transitions.find(x => x.id === transitionId)
    if (!t || t.status !== 'pending') return false
    if (!run.authorized.has(t.to)) { t.status = 'refused'; return false }
    t.status = 'approved'
    run.role = t.to
    return true
  }

  crossRoleLog(runId: string): CrossRoleEntry[] { return [...this.run(runId).crossRole] }

  async invoke<T>(runId: string, tool: string, params: Record<string, unknown>, executor: (p: Record<string, unknown>) => Promise<T>): Promise<InvokeResult<T>> {
    const run = this.run(runId)
    run.m.calls += 1
    if (!run.role) {
      run.m.noRoleFailures += 1
      return { ok: false, kind: 'no-role', reason: 'no role selected; choose a role from the catalog first' }
    }
    const current = this.roles.get(run.role)!
    const def = current.tools[tool]
    if (!def) {
      const owner = [...this.roles.values()].find(r => tool in r.tools)
      if (!owner) {
        run.m.discoveryFailures += 1
        return { ok: false, kind: 'discovery', reason: `no such tool "${tool}"` }
      }
      run.m.authorizationFailures += 1
      run.crossRole.push({ tool, requiredRole: owner.id, currentRole: run.role, at: new Date().toISOString() })
      return { ok: false, kind: 'unauthorized', reason: `"${tool}" is not available in role ${run.role}; request a governed transition` }
    }
    const bad = validateParams(def, params)
    if (bad) {
      run.m.parameterFailures += 1
      return { ok: false, kind: 'param-limit', reason: bad }
    }
    run.m.success += 1
    return { ok: true, result: await executor(params) }
  }

  metrics(runId: string): Metrics {
    const run = this.run(runId)
    const m = run.m
    return {
      ...m,
      crossRoleRequests: run.crossRole.length,
      selectionSuccessRate: m.calls === 0 ? 1 : (m.calls - m.discoveryFailures) / m.calls,
    }
  }
}
