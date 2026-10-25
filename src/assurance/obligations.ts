/**
 * External completion authority (card 168).
 *
 * The agent may ASK whether a run is complete; it can never SAY so. Before a
 * run starts, the harness writes a versioned list of obligations. Only
 * evidence minted by the application or a tool (never the model) can satisfy
 * one, and the final status is computed here, not reported by the model.
 *
 * Two facets are handed out by createRun():
 *   - `authority`: held by the harness. Records evidence, amends scope,
 *     marks the run failed/cancelled/unknown.
 *   - `model`: all the agent ever sees. Read-only snapshot and a completion
 *     request that returns a computed verdict.
 *
 * Prototype status: pure logic, not yet wired into the runtime. Wiring means
 * the tool-execution path calling `authority.record` with evidence derived
 * from real tool results, and the reply path consulting `requestCompletion`.
 *
 * State can be handed in and reported out (card #234), so `run-state.ts` can
 * keep it on disk and a restart picks up the evidence the first boot saw.
 */

export type Obligation = {
  id: string
  description: string
  /** The evidence type that satisfies this obligation, e.g. 'email.sent'. */
  evidenceType: string
  /** Distinct qualified events required. Default 1. */
  minCount?: number
  /**
   * Distinct qualified events allowed (card #229, at-most-once). Default
   * minCount. One more than this means an effect happened twice, and the run
   * can no longer read as complete.
   */
  maxCount?: number
}

export type EvidenceOrigin = 'app' | 'tool' | 'model'

export type Evidence = {
  /** Unique per event. A replayed eventId is a duplicate and counts once. */
  eventId: string
  runId: string
  origin: EvidenceOrigin
  evidenceType: string
  obligationId: string
}

export type RunStatus = 'complete' | 'incomplete' | 'failed' | 'cancelled' | 'unknown'

export type Unmet = { id: string; have: number; need: number }
export type Verdict = { status: RunStatus; version: number; unmet: Unmet[]; reason?: string }

export type RecordResult = { accepted: boolean; reason?: 'duplicate' | 'unqualified-origin' | 'wrong-run' | 'unknown-obligation' | 'evidence-type-mismatch' | 'run-closed' | 'over-limit' }

export type RunSnapshot = { runId: string; version: number; obligations: readonly Readonly<Obligation>[] }

export interface ModelFacet {
  snapshot(): RunSnapshot
  requestCompletion(): Verdict
}

export interface AuthorityFacet extends ModelFacet {
  record(evidence: Evidence): RecordResult
  amend(next: Obligation[], reason: string): void
  fail(reason: string): void
  cancel(reason: string): void
  markUnknown(reason: string): void
}

/** Everything a run knows, as plain data: what run-state.ts writes to disk. */
export type RunState = {
  runId: string
  version: number
  obligations: Obligation[]
  /** obligationId -> eventIds counted under the current spec. */
  satisfied: Record<string, string[]>
  /** Every eventId ever accepted, so a replay stays a duplicate after an amend. */
  seen: string[]
  terminal: { status: Exclude<RunStatus, 'complete' | 'incomplete'>; reason: string } | null
}

export type RunOptions = {
  /** Start from saved state instead of `initial`. */
  state?: RunState
  /** Called after every change, with the state as it now is. */
  onChange?: (state: RunState) => void
}

const QUALIFIED: ReadonlySet<EvidenceOrigin> = new Set(['app', 'tool'])

function freezeObligations(list: Obligation[]): readonly Readonly<Obligation>[] {
  return Object.freeze(list.map(o => Object.freeze({ ...o })))
}

const maxOf = (o: Obligation) => o.maxCount ?? o.minCount ?? 1

function sameSpec(a: Obligation, b: Obligation): boolean {
  return a.evidenceType === b.evidenceType && (a.minCount ?? 1) === (b.minCount ?? 1) && maxOf(a) === maxOf(b)
}

export function createRun(runId: string, initial: Obligation[], opts: RunOptions = {}): { authority: AuthorityFacet; model: ModelFacet } {
  const saved = opts.state
  let version = saved?.version ?? 1
  let obligations = freezeObligations(saved?.obligations ?? initial)
  // obligationId -> distinct eventIds that satisfied it under the current spec
  let satisfied = new Map<string, Set<string>>(Object.entries(saved?.satisfied ?? {}).map(([k, v]) => [k, new Set(v)]))
  const seenEvents = new Set<string>(saved?.seen ?? [])
  let terminal: RunState['terminal'] = saved?.terminal ?? null

  function state(): RunState {
    return {
      runId,
      version,
      obligations: obligations.map(o => ({ ...o })),
      satisfied: Object.fromEntries([...satisfied].map(([k, v]) => [k, [...v]])),
      seen: [...seenEvents],
      terminal,
    }
  }
  const changed = () => opts.onChange?.(state())

  function verdict(): Verdict {
    if (terminal) return { status: terminal.status, version, unmet: [], reason: terminal.reason }
    if (obligations.length === 0) return { status: 'unknown', version, unmet: [], reason: 'no obligations were declared' }
    const over = obligations.find(o => (satisfied.get(o.id)?.size ?? 0) > maxOf(o))
    if (over) {
      const have = satisfied.get(over.id)!.size
      return { status: 'unknown', version, unmet: [], reason: `${over.id} has ${have} events, at most ${maxOf(over)} expected: an effect may have happened twice` }
    }
    const unmet: Unmet[] = []
    for (const o of obligations) {
      const need = o.minCount ?? 1
      const have = satisfied.get(o.id)?.size ?? 0
      if (have < need) unmet.push({ id: o.id, have, need })
    }
    return { status: unmet.length === 0 ? 'complete' : 'incomplete', version, unmet }
  }

  function snapshot(): RunSnapshot {
    return Object.freeze({ runId, version, obligations })
  }

  function close(status: NonNullable<RunState['terminal']>['status'], reason: string): void {
    if (terminal) return
    terminal = { status, reason }
    changed()
  }

  const model: ModelFacet = Object.freeze({ snapshot, requestCompletion: verdict })

  const authority: AuthorityFacet = Object.freeze({
    snapshot,
    requestCompletion: verdict,
    record(e: Evidence): RecordResult {
      if (terminal) return { accepted: false, reason: 'run-closed' }
      if (e.runId !== runId) return { accepted: false, reason: 'wrong-run' }
      if (!QUALIFIED.has(e.origin)) return { accepted: false, reason: 'unqualified-origin' }
      if (seenEvents.has(e.eventId)) return { accepted: false, reason: 'duplicate' }
      const o = obligations.find(x => x.id === e.obligationId)
      if (!o) return { accepted: false, reason: 'unknown-obligation' }
      if (o.evidenceType !== e.evidenceType) return { accepted: false, reason: 'evidence-type-mismatch' }
      seenEvents.add(e.eventId)
      const set = satisfied.get(o.id) ?? new Set<string>()
      set.add(e.eventId)
      satisfied.set(o.id, set)
      changed()
      // Kept, so the verdict can see it, but never counted toward completion.
      if (set.size > maxOf(o)) return { accepted: false, reason: 'over-limit' }
      return { accepted: true }
    },
    amend(next: Obligation[], _reason: string): void {
      if (terminal) return
      const prev = new Map(obligations.map(o => [o.id, o]))
      const kept = new Map<string, Set<string>>()
      for (const o of next) {
        const old = prev.get(o.id)
        const have = satisfied.get(o.id)
        if (old && have && sameSpec(old, o)) kept.set(o.id, have)
      }
      satisfied = kept
      obligations = freezeObligations(next)
      version += 1
      changed()
    },
    fail(reason: string): void { close('failed', reason) },
    cancel(reason: string): void { close('cancelled', reason) },
    markUnknown(reason: string): void { close('unknown', reason) },
  })

  return { authority, model }
}
