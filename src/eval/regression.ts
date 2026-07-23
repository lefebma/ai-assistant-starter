/**
 * Regression diff for the certification harness (Phase 4).
 *
 * Compares a committed baseline run against the current run, per lane, and
 * surfaces the one thing that must gate a merge: a task that used to pass and
 * now fails. Pure functions only, no IO — the CLI owns reading the baseline and
 * printing the result.
 */
import type { CertDiff, LaneDiff, LaneResult, RunArtifact } from './types.js'

function passSet(lane: LaneResult): Map<string, boolean> {
  return new Map(lane.results.map(r => [r.task, r.pass]))
}

function diffLane(baseline: LaneResult | undefined, current: LaneResult): LaneDiff {
  const base = baseline ? passSet(baseline) : new Map<string, boolean>()
  const curr = passSet(current)

  const regressions: string[] = []
  const fixes: string[] = []
  const added: string[] = []

  for (const [task, nowPass] of curr) {
    if (!base.has(task)) {
      added.push(task)
      continue
    }
    const wasPass = base.get(task)!
    if (wasPass && !nowPass) regressions.push(task)
    else if (!wasPass && nowPass) fixes.push(task)
  }

  const removed: string[] = []
  for (const task of base.keys()) {
    if (!curr.has(task)) removed.push(task)
  }

  return {
    lane: current.name,
    regressions,
    fixes,
    added,
    removed,
    baselinePass: baseline ? baseline.results.filter(r => r.pass).length : 0,
    currentPass: current.results.filter(r => r.pass).length,
    total: current.results.length,
  }
}

/**
 * Diff the current run against a baseline. Lanes are matched by name; a lane
 * present only in the current run has every task counted as `added` and, by
 * definition, no regressions.
 */
export function diffRuns(baseline: RunArtifact, current: RunArtifact): CertDiff {
  const lanes = current.lanes.map(cur =>
    diffLane(
      baseline.lanes.find(b => b.name === cur.name),
      cur,
    ),
  )
  const currentNames = new Set(current.lanes.map(l => l.name))
  const missingLanes = baseline.lanes.map(l => l.name).filter(name => !currentNames.has(name))
  return { lanes, missingLanes, hasRegression: lanes.some(l => l.regressions.length > 0) }
}
