/**
 * tests/eval-regression.test.ts
 *
 * Phase 4 certification: the regression diff is the "view" that makes the
 * golden-set persist-and-compare loop useful. diffRuns() takes a committed
 * baseline RunArtifact and the current run and reports, per lane:
 *   - regressions: tasks that passed in the baseline but fail now (the thing
 *     that must gate CI),
 *   - fixes: tasks that failed in the baseline but pass now,
 *   - added / removed: tasks present in only one of the two runs (catalog drift),
 *   - pass counts for a quick pass-rate delta.
 * hasRegression is true iff some lane has at least one regression, so the CLI
 * can exit non-zero on it. Lanes are matched by name; a lane only in the current
 * run has every task "added" and, by definition, no regressions.
 */
import { describe, expect, it } from 'vitest'
import { diffRuns } from '../src/eval/regression.js'
import type { LaneResult, RunArtifact } from '../src/eval/types.js'

function lane(name: string, pass: Record<string, boolean>): LaneResult {
  return {
    name,
    results: Object.entries(pass).map(([task, ok]) => ({
      task,
      pass: ok,
      detail: ok ? 'ok' : 'nope',
      ms: 1,
    })),
  }
}

function run(lanes: LaneResult[]): RunArtifact {
  return { version: 1, createdAt: '2026-07-23T00:00:00.000Z', tier: 'full', lanes }
}

describe('diffRuns', () => {
  it('flags a task that passed in the baseline but fails now as a regression', () => {
    const baseline = run([lane('anthropic', { identity: true, bash: true })])
    const current = run([lane('anthropic', { identity: true, bash: false })])

    const diff = diffRuns(baseline, current)

    expect(diff.hasRegression).toBe(true)
    expect(diff.lanes).toHaveLength(1)
    expect(diff.lanes[0].regressions).toEqual(['bash'])
    expect(diff.lanes[0].fixes).toEqual([])
  })

  it('flags a task that failed in the baseline but passes now as a fix, not a regression', () => {
    const baseline = run([lane('openai', { edit: false })])
    const current = run([lane('openai', { edit: true })])

    const diff = diffRuns(baseline, current)

    expect(diff.hasRegression).toBe(false)
    expect(diff.lanes[0].fixes).toEqual(['edit'])
    expect(diff.lanes[0].regressions).toEqual([])
  })

  it('reports added and removed tasks from catalog drift', () => {
    const baseline = run([lane('google', { old: true, keep: true })])
    const current = run([lane('google', { keep: true, fresh: true })])

    const diff = diffRuns(baseline, current)

    expect(diff.lanes[0].added).toEqual(['fresh'])
    expect(diff.lanes[0].removed).toEqual(['old'])
    // a task only in the baseline is not a regression (it's gone, not broken)
    expect(diff.lanes[0].regressions).toEqual([])
  })

  it('counts pass totals per lane for a pass-rate delta', () => {
    const baseline = run([lane('anthropic', { a: true, b: true, c: false })])
    const current = run([lane('anthropic', { a: true, b: false, c: true })])

    const diff = diffRuns(baseline, current)

    expect(diff.lanes[0].baselinePass).toBe(2)
    expect(diff.lanes[0].currentPass).toBe(2)
    expect(diff.lanes[0].total).toBe(3)
  })

  it('diffs each lane independently and aggregates hasRegression across lanes', () => {
    const baseline = run([
      lane('anthropic', { x: true }),
      lane('openai', { x: true }),
    ])
    const current = run([
      lane('anthropic', { x: true }), // clean
      lane('openai', { x: false }), // regressed
    ])

    const diff = diffRuns(baseline, current)

    expect(diff.lanes.find(l => l.lane === 'anthropic')?.regressions).toEqual([])
    expect(diff.lanes.find(l => l.lane === 'openai')?.regressions).toEqual(['x'])
    expect(diff.hasRegression).toBe(true)
  })

  it('treats a lane present only in the current run as all-added with no regressions', () => {
    const baseline = run([lane('anthropic', { x: true })])
    const current = run([
      lane('anthropic', { x: true }),
      lane('google', { x: true, y: false }),
    ])

    const diff = diffRuns(baseline, current)

    const g = diff.lanes.find(l => l.lane === 'google')
    expect(g?.added.sort()).toEqual(['x', 'y'])
    expect(g?.regressions).toEqual([])
    expect(diff.hasRegression).toBe(false)
  })
})

describe('diffRuns lane drift', () => {
  it('surfaces a certified lane that did not run this time as missingLanes', () => {
    // A lane that was in the baseline but is absent from the current run means
    // we are no longer verifying something we certified (e.g. a provider whose
    // key went missing). It is not a task-level regression, but it must not
    // vanish silently: diffRuns reports it in missingLanes so the CLI can warn
    // and fail the gate.
    const baseline = run([
      lane('anthropic', { x: true }),
      lane('openai', { x: true }),
    ])
    const current = run([lane('anthropic', { x: true })])

    const diff = diffRuns(baseline, current)

    expect(diff.lanes.map(l => l.lane)).toEqual(['anthropic'])
    expect(diff.missingLanes).toEqual(['openai'])
    // hasRegression stays strictly task-level (pass -> fail); the missing lane
    // is a separate signal the CLI folds into its exit decision.
    expect(diff.hasRegression).toBe(false)
  })

  it('reports no missing lanes when the current run covers every baseline lane', () => {
    const baseline = run([lane('anthropic', { x: true })])
    const current = run([lane('anthropic', { x: true }), lane('openai', { x: true })])

    expect(diffRuns(baseline, current).missingLanes).toEqual([])
  })
})
