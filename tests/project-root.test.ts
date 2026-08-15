import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'

/**
 * Every module that needs the install root used to work it out by counting
 * '..' from its own __dirname. That answer depends on how deep the file sits
 * AND on whether it is running compiled or from source, so it was wrong in
 * four files at once and, crucially, wrong ONLY when compiled — which is to
 * say wrong in every customer install and right in every dev run and test.
 *
 * What it cost:
 *   - skills/sync.ts      -> dist/src : always-on skills never synced on update
 *   - memory/.../project.ts -> dist   : project context never found, ever
 *   - media.ts            -> dist     : uploads written where the next update deletes them
 *   - scripts/status.ts   -> dist     : status reported on a store that was not there
 *
 * None of it surfaced as an error. env.ts finds the nearest package.json
 * instead, which is correct in both modes; these tests keep everyone on it.
 */

const SRC_DIRS = ['src', 'scripts']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walk(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('PROJECT_ROOT', () => {
  it('points at the install root, not somewhere inside dist', () => {
    expect(existsSync(join(PROJECT_ROOT, 'package.json'))).toBe(true)
    expect(PROJECT_ROOT.split(sep).pop()).not.toBe('dist')
  })

  it('resolves the directories setup actually creates', () => {
    // These are the four the broken roots pointed away from. If PROJECT_ROOT
    // drifts into dist/, none of them exist and every consumer fails silently.
    for (const d of ['templates', 'src', 'scripts']) {
      expect(existsSync(join(PROJECT_ROOT, d))).toBe(true)
    }
  })

  it('is stable no matter how deep the importing module sits', () => {
    // env.ts is at src/; a module at src/memory/providers/ must agree with it.
    // Counting '..' is exactly what could not satisfy this.
    const deep = resolve(PROJECT_ROOT, 'src', 'memory', 'providers')
    let dir = deep
    for (let i = 0; i < 6; i++) {
      if (existsSync(resolve(dir, 'package.json'))) break
      dir = resolve(dir, '..')
    }
    expect(dir).toBe(PROJECT_ROOT)
  })
})

describe('no module recomputes the root by counting ..', () => {
  // The regression guard. A new file that hand-rolls its own root is the bug
  // coming back, and it would pass every other test in the suite.
  it('nothing outside env.ts derives a root from __dirname', () => {
    const offenders: string[] = []
    for (const base of SRC_DIRS) {
      for (const file of walk(resolve(PROJECT_ROOT, base))) {
        const rel = relative(PROJECT_ROOT, file).split(sep).join('/')
        if (rel === 'src/env.ts') continue // the one legitimate definition
        // Comments are stripped first: the fixed files explain the old bug by
        // quoting the very pattern this looks for, and a guard that fires on
        // its own documentation teaches people to delete the documentation.
        const code = readFileSync(file, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        // Matches resolve(__dirname, '..') with any number of segments.
        if (/resolve\(\s*__dirname\s*,\s*(['"]\.\.['"]\s*,?\s*)+\)/.test(code)) {
          offenders.push(rel)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('env.ts still owns a single exported PROJECT_ROOT', () => {
    const env = readFileSync(resolve(PROJECT_ROOT, 'src', 'env.ts'), 'utf-8')
    expect(env).toMatch(/export const PROJECT_ROOT/)
    // config.ts re-exports rather than defining a second one that can diverge.
    const config = readFileSync(resolve(PROJECT_ROOT, 'src', 'config.ts'), 'utf-8')
    expect(config).not.toMatch(/export const PROJECT_ROOT\s*=/)
  })
})
