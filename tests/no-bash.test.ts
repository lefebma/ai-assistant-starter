import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', 'dist', 'store', 'logs', 'scripts'])
function findShellScripts(dir: string, hits: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) findShellScripts(p, hits)
    else if (name.endsWith('.sh')) hits.push(p.slice(ROOT.length + 1))
  }
}

describe('no bash in the product', () => {
  it('ships zero .sh files (all automation is Node/TypeScript)', () => {
    // Bash does not run on Windows, and macOS bash is BSD-flavored enough to
    // break on Linux. One language for automation: the one the product runs on.
    const hits: string[] = []
    findShellScripts(ROOT, hits)
    expect(hits).toEqual([])
  })
})
