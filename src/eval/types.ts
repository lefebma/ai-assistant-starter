/**
 * Shared types for the golden-set certification harness (Phase 4).
 *
 * The eval catalog, runner, persistence, and regression diff all speak these
 * types. Kept in one leaf module so `scripts/ab-eval.ts` stays a thin CLI and
 * the logic underneath it is unit-testable without spawning a real runtime.
 */

/** Coarse capability bucket a task exercises. Drives the matrix grouping. */
export type Category =
  | 'persona'
  | 'datetime'
  | 'shell'
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'multi-step'
  | 'memory'
  | 'instruction'
  | 'error-recovery'
  | 'retrieval'

/**
 * Certification tier. `smoke` is the fast subset for casual/CI runs; `full` is
 * the whole catalog (the certification grid). smoke ⊂ full: every smoke task is
 * also part of a full run.
 */
export type Tier = 'smoke' | 'full'

export type TaskContext = { dir: string }

export type Task = {
  name: string
  category: Category
  tier: Tier
  message: (ctx: TaskContext) => string
  /** Two-turn tasks send this on the same session to test memory/resume. */
  followUp?: (ctx: TaskContext) => string
  /** Return true for pass, or a string describing the failure. */
  check: (finalText: string, ctx: TaskContext) => true | string
}

export type TaskResult = { task: string; pass: boolean; detail: string; ms: number }
export type LaneResult = { name: string; results: TaskResult[] }

/** One persisted grid execution across lanes. */
export type RunArtifact = {
  version: 1
  /** ISO timestamp of the run. */
  createdAt: string
  tier: Tier
  lanes: LaneResult[]
}

/** Per-lane comparison of a baseline run against the current run. */
export type LaneDiff = {
  lane: string
  /** Task names that passed in the baseline but fail now. Gates CI. */
  regressions: string[]
  /** Task names that failed in the baseline but pass now. */
  fixes: string[]
  /** Task names present in the current run but not the baseline. */
  added: string[]
  /** Task names present in the baseline but not the current run. */
  removed: string[]
  baselinePass: number
  currentPass: number
  total: number
}

export type CertDiff = {
  lanes: LaneDiff[]
  /** Baseline lane names absent from the current run (certified but unverified). */
  missingLanes: string[]
  /** True iff any lane has at least one regression. */
  hasRegression: boolean
}
