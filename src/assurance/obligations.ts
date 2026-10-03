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
 */

export type Obligation = {
  id: string
  description: string
  /** The evidence type that satisfies this obligation, e.g. 'email.sent'. */
  evidenceType: string
  /** Distinct qualified events required. Default 1. */
  minCount?: number
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

export type RecordResult = { accepted: boolean; reason?: 'duplicate' | 'unqualified-origin' | 'wrong-run' | 'unknown-obligation' | 'evidence-type-mismatch' | 'run-closed' }

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

const QUALIFIED: ReadonlySet<EvidenceOrigin> = new Set(['app', 'tool'])

function freezeObligations(list: Obligation[]): readonly Readonly<Obligation>[] {
  return Object.freeze(list.map(o => Object.freeze({ ...o })))
}

function sameSpec(a: Obligation, b: Obligation): boolean {
  return a.evidenceType === b.evidenceType && (a.minCount ?? 1) === (b.minCount ?? 1)
}

export function createRun(runId: string, initial: Obligation[]): { authority: AuthorityFacet; model: ModelFacet } {
  let version = 1
  let obligations = freezeObligations(initial)
  // obligationId -> distinct eventIds that satisfied it under the current spec
  let satisfied = new Map<string, Set<string>>()
  const seenEvents = new Set<string>()
  let terminal: { status: Exclude<RunStatus, 'complete' | 'incomplete'>; reason: string } | null = null

  function verdict(): Verdict {
    if (terminal) return { status: terminal.status, version, unmet: [], reason: terminal.reason }
    if (obligations.length === 0) return { status: 'unknown', version, unmet: [], reason: 'no obligations were declared' }
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
    },
    fail(reason: string): void { terminal ??= { status: 'failed', reason } },
    cancel(reason: string): void { terminal ??= { status: 'cancelled', reason } },
    markUnknown(reason: string): void { terminal ??= { status: 'unknown', reason } },
  })

  return { authority, model }
}
