/**
 * Persistence for certification runs (Phase 4).
 *
 * Two artifacts, both plain JSON so they diff cleanly in git:
 *   - certification/baseline.json  the certified bar; committed, compared
 *     against on every run, promoted with --update-baseline.
 *   - certification/runs/<ts>.json  optional per-run history (--save).
 *
 * Every function takes the certification base directory (default: the repo's
 * certification/ folder) so tests write to a throwaway dir.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import type { RunArtifact } from './types.js'

/** Default committed location for certification artifacts. */
export const CERT_DIR = resolve(PROJECT_ROOT, 'certification')

export function baselinePath(baseDir: string = CERT_DIR): string {
  return join(baseDir, 'baseline.json')
}

export function writeBaseline(artifact: RunArtifact, baseDir: string = CERT_DIR): string {
  mkdirSync(baseDir, { recursive: true })
  const path = baselinePath(baseDir)
  writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n')
  return path
}

export function loadBaseline(baseDir: string = CERT_DIR): RunArtifact | null {
  const path = baselinePath(baseDir)
  if (!existsSync(path)) return null
  return loadRun(path)
}

/** Save a run to the history directory, filename derived from its timestamp. */
export function writeRun(artifact: RunArtifact, baseDir: string = CERT_DIR): string {
  const runsDir = join(baseDir, 'runs')
  mkdirSync(runsDir, { recursive: true })
  const stamp = artifact.createdAt.replace(/[:.]/g, '-')
  const path = join(runsDir, `${stamp}.json`)
  writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n')
  return path
}

export function loadRun(path: string): RunArtifact {
  return JSON.parse(readFileSync(path, 'utf-8')) as RunArtifact
}
