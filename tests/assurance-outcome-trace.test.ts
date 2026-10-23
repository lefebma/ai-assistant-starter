import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../src/assurance/audit-log.js'
import { OutcomeTracer, baselineRuns, costOf, outcomeReport, percentile, reconstruct, renderTrace } from '../src/assurance/outcome-trace.js'
import { PRICES, runScenarios, type ScenarioResult } from '../src/assurance/outcome-trace-scenarios.js'

let base: string
let r: ScenarioResult

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'spike219-'))
  r = runScenarios(base)
  if (process.env.SPIKE_PRINT) {
    for (const t of r.traces.values()) console.log(renderTrace(t) + `\n  verdict: ${JSON.stringify(r.verdicts.get(t.traceId))}\n`)
    console.log(JSON.stringify(baselineRuns(r.baselineLog.eventsAfter(0)), null, 1))
    console.log(JSON.stringify(outcomeReport([...r.traces.values()], r.verdicts, PRICES), null, 1))
  }
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('outcome tracing on the audit log (spike #219)', () => {
  it('spans ride the existing hash chain and verify clean, across the restart', () => {
    expect(r.traceLog.verify()).toMatchObject({ ok: true })
    expect(r.baselineLog.verify()).toMatchObject({ ok: true })
  })

  it('rebuilds one chain per workflow: request, authorize, execute, verify', () => {
    expect(r.traces.size).toBe(6)
    for (const t of r.traces.values()) {
      expect(t.root?.kind).toBe('request')
      const kinds = t.root!.children.map(c => c.kind)
      expect(kinds[0]).toBe('authorize')
      expect(kinds).toContain('verify')
    }
  })

  it('keeps the subagent under its parent, with its own actor', () => {
    const t = r.traces.get('wf-subagent')!
    const sub = t.root!.children.find(c => c.kind === 'subagent')!
    expect(sub.children.map(c => c.kind)).toEqual(['model', 'tool', 'model'])
    expect(sub.children.every(c => c.actor === 'subagent:research')).toBe(true)
    expect(t.missing).toEqual([])
  })

  it('splits time by kind, so a three-hour approval wait is not model latency', () => {
    const t = r.traces.get('wf-approval')!
    expect(t.byKindMs.human_wait).toBe(3 * 3600_000 + 20 * 60_000)
    expect(t.byKindMs.model).toBe(6400)
  })

  it('completion comes from the destination, never from the model', () => {
    expect(r.verdicts.get('wf-success')?.status).toBe('complete')
    expect(r.verdicts.get('wf-approval')?.status).toBe('complete')
    expect(r.verdicts.get('wf-subagent')?.status).toBe('complete')
    // The model said "sent" in both of these. The mailbox disagrees.
    expect(r.verdicts.get('wf-partial')).toMatchObject({ status: 'incomplete', unmet: [{ id: 'delivered', have: 2, need: 3 }] })
    expect(r.verdicts.get('wf-missing')).toMatchObject({ status: 'incomplete', unmet: [{ id: 'delivered', have: 0, need: 1 }] })
    expect(r.refused.get('wf-partial')).toBe(1)
    expect(r.refused.get('wf-missing')).toBe(1)
  })

  it('a restart keeps the workflow: obligations rebuilt from the log, run counted as reopened', () => {
    const t = r.traces.get('wf-restart')!
    expect(t.resumed).toBe(true)
    expect(t.missing).toEqual([])
    expect(r.verdicts.get('wf-restart')?.status).toBe('complete')
  })

  it('flags the span that never closed', () => {
    const t = r.traces.get('wf-missing')!
    expect(t.missing).toEqual([{ spanId: expect.any(String), problem: 'no-end' }])
    expect(renderTrace(t)).toContain('OPEN')
  })

  it('counts retries and prices them into the cost per verified outcome', () => {
    const rep = outcomeReport([...r.traces.values()], r.verdicts, PRICES)
    expect(rep).toMatchObject({ workflows: 6, verified: 4, retries: 2, missingSpans: 1 })
    expect(rep.unresolved.sort()).toEqual(['wf-missing', 'wf-partial'])
    expect(rep.reopened).toEqual(['wf-restart'])
    expect(rep.usdPerVerifiedOutcome).toBeCloseTo(rep.totalUsd / 4, 10)
    expect(rep.p50Ms).toBeLessThan(rep.p95Ms!)
    // The failing workflow costs more than the clean one, and that cost lands on verified outcomes.
    expect(costOf(r.traces.get('wf-partial')!, PRICES)).toBeGreaterThan(costOf(r.traces.get('wf-success')!, PRICES))
  })

  it("today's trail alone: tool calls per session, nothing more", () => {
    const runs = baselineRuns(r.baselineLog.eventsAfter(0))
    // The subagent's call is orphaned under the cwd key, and the restart splits one job into two sessions.
    expect(runs.map(x => x.runId)).toEqual(['sess-1', 'sess-2', 'sess-3', 'ai-sdk:/synthetic/workspace', 'sess-4', 'sess-5a', 'sess-6'])
    // A failed send and a delivered one look the same: the guard allowed both.
    expect(runs.find(x => x.runId === 'sess-6')!.outcomes).toEqual(['allowed'])
    // No model, human wait or verify events exist to time or prove anything.
    expect(runs.flatMap(x => x.tools).every(t => t.startsWith('mcp__') || t === 'WebFetch')).toBe(true)
  })

  it('what leaves the box: workflow id in clear, span detail only as a hash', async () => {
    const { fingerprint } = await import('../src/assurance/witness-protocol.js')
    const e = r.traceLog.eventsAfter(0)[0]
    const shipped = await fingerprint(e)
    expect(shipped.runId).toBe('wf-success')
    expect(JSON.stringify(shipped)).not.toContain('send-invoice-reminder')
  })
})

describe('outcome-trace primitives', () => {
  it('percentile is nearest-rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(percentile([], 50)).toBeUndefined()
  })

  it('an orphan span (parent never written) is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike219o-'))
    try {
      const log = new AuditLog({ dir: join(dir, 'a'), workspace: join(dir, 'w') })
      const tr = new OutcomeTracer(log, () => 0, 'x')
      const c = tr.start('t', 'tool', 'n', { traceId: 't', spanId: 's999' })
      tr.end(c, 'tool', 'n', { status: 'ok' })
      expect(reconstruct(log.eventsAfter(0)).get('t')!.missing).toEqual([{ spanId: c.spanId, problem: 'orphan' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores ordinary tool-call records in the same log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike219i-'))
    try {
      const log = new AuditLog({ dir: join(dir, 'a'), workspace: join(dir, 'w') })
      log.append({ runId: 'sess', actor: 'chat:x', action: 'Bash', outcome: 'allowed', detail: 'Bash ls' })
      expect(reconstruct(log.eventsAfter(0)).size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
