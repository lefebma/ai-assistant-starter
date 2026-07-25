import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The public product must not ship references to the author's personal
 * machine layout or private instance name. Anything dashboard-integration
 * shaped must be env-driven and default to off.
 */
const FORBIDDEN = /clawd|ClaudeClaw/

function scan(dir: string, hits: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      scan(p, hits)
    } else if (/\.(ts|js|json|md)$/.test(name)) {
      const text = readFileSync(p, 'utf-8')
      if (FORBIDDEN.test(text)) hits.push(p.slice(ROOT.length + 1))
    }
  }
}

describe('no personal paths in shipped code', () => {
  it('src/ and scripts/ carry no clawd/ClaudeClaw references', () => {
    const hits: string[] = []
    scan(join(ROOT, 'src'), hits)
    scan(join(ROOT, 'scripts'), hits)
    expect(hits).toEqual([])
  })
})
