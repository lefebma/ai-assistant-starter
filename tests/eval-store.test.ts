/**
 * tests/eval-store.test.ts
 *
 * Phase 4 certification: persistence for run artifacts. The certified bar lives
 * in a single committed baseline.json (so cert drift shows up in a PR diff);
 * individual runs can also be saved to a runs/ history directory. All functions
 * take a base directory so tests write to a throwaway tmp dir and never touch
 * the repo's real certification/ folder.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBaseline, writeBaseline, writeRun, loadRun } from '../src/eval/store.js'
import type { RunArtifact } from '../src/eval/types.js'

const artifact: RunArtifact = {
  version: 1,
  createdAt: '2026-07-23T14:30:05.000Z',
  tier: 'full',
  lanes: [
    {
      name: 'anthropic (claude-sonnet-5)',
      results: [
        { task: 'identity', pass: true, detail: 'ok', ms: 120 },
        { task: 'bash', pass: false, detail: 'expected 42', ms: 90 },
      ],
    },
  ],
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('baseline persistence', () => {
  it('round-trips a baseline artifact through write/load', () => {
    writeBaseline(artifact, dir)
    expect(loadBaseline(dir)).toEqual(artifact)
  })

  it('returns null when no baseline has been written yet', () => {
    expect(loadBaseline(dir)).toBeNull()
  })
})

describe('run history persistence', () => {
  it('writes a run artifact and reads it back equal', () => {
    const path = writeRun(artifact, dir)
    expect(existsSync(path)).toBe(true)
    expect(loadRun(path)).toEqual(artifact)
  })

  it('derives the run filename from the artifact timestamp (no wall-clock read)', () => {
    const path = writeRun(artifact, dir)
    // colons are not filename-safe on all platforms; expect them sanitized out
    expect(path).not.toContain(':')
    expect(path).toContain('2026-07-23')
  })
})
