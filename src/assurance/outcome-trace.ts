/**
 * Outcome tracing on top of the audit log (spike #219).
 *
 * The question this answers: can Havn reconstruct one chain from a business
 * request, through authorization and execution, to an outcome checked against
 * the destination itself, using only what it already has (the hash-chained
 * audit log of #169/#196 and the obligation checker of #168)? Or does that
 * need LangSmith?
 *
 * The extension is small on purpose. A span is two ordinary audit events, a
 * start and an end, so it inherits the chain, the append-only file and the
 * off-box witness for free. The workflow id goes in `runId`, which the witness
 * receives in clear; everything else (span id, parent, kind, timings, tokens)
 * goes in `detail`, which leaves the box only as a SHA-256. Span ids are the
 * audit seq of the start event, so they survive a restart and double as the
 * evidence locator.
 *
 * Completion is never read from the trace. A run is complete when the
 * obligation checker says so, and the only evidence it accepts here is a
 * `verify` span that read the destination (a mailbox, a calendar) directly.
 * What the model said about its own work is recorded, and refused.
 *
 * Prototype status: synthetic only, not wired into either runtime. Wiring is
 * the cost estimate in docs/specs/2026-10-22-telemetry-spike.md.
 */
import { AuditLog, type AuditEvent } from './audit-log.js'
import { createRun, type Obligation, type Verdict } from './obligations.js'

export type SpanKind = 'request' | 'authorize' | 'orchestration' | 'model' | 'tool' | 'human_wait' | 'subagent' | 'verify'
export type SpanStatus = 'ok' | 'error' | 'denied'

/** What a span end can carry. Counts and names only: never message text. */
export type SpanEnd = {
  status: SpanStatus
  attempt?: number
  model?: string
  tokensIn?: number
  tokensOut?: number
  /** For a verify span: the destination record it found, e.g. `mailbox:msg-1`. */
  evidence?: string[]
  note?: string
}

type Mark = {
  v: 1
  span: string
  parent?: string
  kind: SpanKind
  name: string
  phase: 'start' | 'end'
  at: number
} & Partial<SpanEnd>

const PREFIX = 'trace '

export type SpanRef = { traceId: string; spanId: string }

/** Writes span marks into an audit log. The clock is injected so tests are deterministic. */
export class OutcomeTracer {
  constructor(private log: AuditLog, private clock: () => number, private actor: string) {}

  start(traceId: string, kind: SpanKind, name: string, parent?: SpanRef): SpanRef {
    const spanId = `s${this.log.headOf().seq + 1}`
    this.write(traceId, { v: 1, span: spanId, parent: parent?.spanId, kind, name, phase: 'start', at: this.clock() }, 'allowed')
    return { traceId, spanId }
  }

  end(ref: SpanRef, kind: SpanKind, name: string, end: SpanEnd): AuditEvent {
    const outcome = end.status === 'denied' ? 'denied' : 'allowed'
    return this.write(ref.traceId, { v: 1, span: ref.spanId, kind, name, phase: 'end', at: this.clock(), ...end }, outcome)
  }

  private write(traceId: string, mark: Mark, outcome: AuditEvent['outcome']): AuditEvent {
    return this.log.append({ runId: traceId, actor: this.actor, action: `span.${mark.kind}`, outcome, detail: PREFIX + JSON.stringify(mark) })
  }
}

// ---- reconstruction -------------------------------------------------------

export type Span = {
  traceId: string
  spanId: string
  parent?: string
  kind: SpanKind
  name: string
  actor: string
  start?: number
  end?: number
  status?: SpanStatus
  attempt?: number
  model?: string
  tokensIn?: number
  tokensOut?: number
  evidence?: string[]
  /** Audit seqs of the start and end events: where the proof lives. */
  seqs: number[]
  children: Span[]
}

export type MissingSpan = { spanId: string; problem: 'no-end' | 'no-start' | 'orphan' }

export type Trace = {
  traceId: string
  root?: Span
  spans: Span[]
  missing: MissingSpan[]
  /** Request start to the last span end. */
  durationMs?: number
  byKindMs: Partial<Record<SpanKind, number>>
  resumed: boolean
  retries: number
}

function parseMark(e: AuditEvent): Mark | null {
  if (!e.detail.startsWith(PREFIX)) return null
  try {
    const m = JSON.parse(e.detail.slice(PREFIX.length)) as Mark
    return m.v === 1 && typeof m.span === 'string' ? m : null
  } catch {
    return null
  }
}

/** Rebuild every trace in a log: the parent/child tree, timings and the spans that never closed. */
export function reconstruct(events: AuditEvent[]): Map<string, Trace> {
  const spans = new Map<string, Span>()
  for (const e of events) {
    const m = parseMark(e)
    if (!m) continue
    const key = `${e.runId}\0${m.span}`
    const s = spans.get(key) ?? { traceId: e.runId, spanId: m.span, kind: m.kind, name: m.name, actor: e.actor, seqs: [], children: [] }
    s.seqs.push(e.seq)
    if (m.phase === 'start') {
      s.start = m.at
      s.parent = m.parent
    } else {
      s.end = m.at
      s.status = m.status
      s.attempt = m.attempt
      s.model = m.model
      s.tokensIn = m.tokensIn
      s.tokensOut = m.tokensOut
      s.evidence = m.evidence
    }
    spans.set(key, s)
  }

  const traces = new Map<string, Trace>()
  for (const s of spans.values()) {
    const t = traces.get(s.traceId) ?? { traceId: s.traceId, spans: [], missing: [], byKindMs: {}, resumed: false, retries: 0 }
    t.spans.push(s)
    traces.set(s.traceId, t)
  }
  for (const t of traces.values()) {
    const byId = new Map(t.spans.map(s => [s.spanId, s]))
    for (const s of t.spans) {
      if (s.start === undefined) t.missing.push({ spanId: s.spanId, problem: 'no-start' })
      if (s.end === undefined) t.missing.push({ spanId: s.spanId, problem: 'no-end' })
      if (s.parent) {
        const p = byId.get(s.parent)
        if (p) p.children.push(s)
        else t.missing.push({ spanId: s.spanId, problem: 'orphan' })
      } else if (s.kind === 'request' && !t.root) t.root = s
      if (s.start !== undefined && s.end !== undefined) t.byKindMs[s.kind] = (t.byKindMs[s.kind] ?? 0) + (s.end - s.start)
      if (s.kind === 'orchestration' && s.name === 'resume') t.resumed = true
      if ((s.attempt ?? 1) > 1) t.retries++
    }
    const ends = t.spans.map(s => s.end).filter((x): x is number => x !== undefined)
    if (t.root?.start !== undefined && ends.length) t.durationMs = Math.max(...ends) - t.root.start
  }
  return traces
}

/** An indented one-line-per-span view of a trace, for the spike note. */
export function renderTrace(t: Trace): string {
  const out: string[] = [`trace ${t.traceId}`]
  const walk = (s: Span, depth: number) => {
    const dur = s.start !== undefined && s.end !== undefined ? `${((s.end - s.start) / 1000).toFixed(1)}s` : 'OPEN'
    const extra = [
      s.status ?? 'no-end',
      s.attempt && s.attempt > 1 ? `attempt ${s.attempt}` : '',
      s.model ? `${s.model} ${s.tokensIn ?? 0}/${s.tokensOut ?? 0} tok` : '',
      s.evidence?.length ? `evidence ${s.evidence.join(',')}` : '',
      `audit#${s.seqs.join(',')}`,
    ].filter(Boolean).join(' | ')
    out.push(`${'  '.repeat(depth + 1)}${s.kind}:${s.name} [${s.actor}] ${dur} | ${extra}`)
    for (const c of [...s.children].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) walk(c, depth + 1)
  }
  if (t.root) walk(t.root, 0)
  for (const m of t.missing) out.push(`  MISSING ${m.spanId}: ${m.problem}`)
  return out.join('\n')
}

// ---- completion -----------------------------------------------------------

/**
 * The obligation checker lives in memory (createRun), so a restart loses it.
 * Rebuild it from the log: declare the same obligations, then replay every
 * verify span's destination evidence. Model-origin claims are replayed too,
 * and refused, exactly as they were the first time.
 */
export function verdictFromLog(traceId: string, obligations: Obligation[], events: AuditEvent[], evidenceType: (evidence: string) => { type: string; obligationId: string } | null): { verdict: Verdict; refused: number } {
  const { authority } = createRun(traceId, obligations)
  let refused = 0
  for (const e of events) {
    if (e.runId !== traceId) continue
    const m = parseMark(e)
    if (!m || m.phase !== 'end') continue
    // A verify span read the destination; a human wait ends on the owner's
    // click, which the app mints. Anything else is the model talking.
    const origin = m.kind === 'verify' || m.kind === 'human_wait' ? 'app' : 'model'
    for (const ev of m.evidence ?? []) {
      const map = evidenceType(ev)
      if (!map) continue
      const r = authority.record({ eventId: ev, runId: traceId, origin, evidenceType: map.type, obligationId: map.obligationId })
      if (!r.accepted) refused++
    }
  }
  return { verdict: authority.requestCompletion(), refused }
}

// ---- outcome metrics ------------------------------------------------------

/** USD per million tokens. Synthetic: usage_log keeps tokens only, by design. */
export type PriceTable = Record<string, { in: number; out: number }>

export function costOf(t: Trace, prices: PriceTable): number {
  let usd = 0
  for (const s of t.spans) {
    if (!s.model) continue
    const p = prices[s.model]
    if (!p) continue
    usd += ((s.tokensIn ?? 0) * p.in + (s.tokensOut ?? 0) * p.out) / 1_000_000
  }
  return usd
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

export type OutcomeReport = {
  workflows: number
  verified: number
  unresolved: string[]
  reopened: string[]
  p50Ms?: number
  p95Ms?: number
  totalUsd: number
  /** All spend, including failed and retried work, over verified outcomes only. */
  usdPerVerifiedOutcome?: number
  retries: number
  missingSpans: number
}

export function outcomeReport(traces: Trace[], verdicts: Map<string, Verdict>, prices: PriceTable): OutcomeReport {
  const verified = traces.filter(t => verdicts.get(t.traceId)?.status === 'complete')
  const durations = traces.map(t => t.durationMs).filter((x): x is number => x !== undefined)
  const totalUsd = traces.reduce((n, t) => n + costOf(t, prices), 0)
  return {
    workflows: traces.length,
    verified: verified.length,
    unresolved: traces.filter(t => verdicts.get(t.traceId)?.status !== 'complete').map(t => t.traceId),
    reopened: traces.filter(t => t.resumed).map(t => t.traceId),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    totalUsd,
    usdPerVerifiedOutcome: verified.length ? totalUsd / verified.length : undefined,
    retries: traces.reduce((n, t) => n + t.retries, 0),
    missingSpans: traces.reduce((n, t) => n + t.missing.length, 0),
  }
}

// ---- what today's records alone give -------------------------------------

export type BaselineRun = { runId: string; actors: string[]; tools: string[]; outcomes: string[]; firstTs: string; lastTs: string }

/**
 * Group today's tool-call audit records (audit-trail.ts) by run. This is all
 * the shipped trail can say: which session called which tools, allowed or
 * not, and when. No parent links, no model or wait time, no destination check.
 */
export function baselineRuns(events: AuditEvent[]): BaselineRun[] {
  const runs = new Map<string, BaselineRun>()
  for (const e of events) {
    const r = runs.get(e.runId) ?? { runId: e.runId, actors: [], tools: [], outcomes: [], firstTs: e.ts, lastTs: e.ts }
    if (!r.actors.includes(e.actor)) r.actors.push(e.actor)
    r.tools.push(e.action)
    r.outcomes.push(e.outcome)
    r.lastTs = e.ts
    runs.set(e.runId, r)
  }
  return [...runs.values()]
}
