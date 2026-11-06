/**
 * The list of tips, and the rule that a feature is not done without one
 * (card #273). A `- **New:` line in the changelog from TIPS_REQUIRED_FROM on
 * needs a tip with that version as `since`. Provider-only work is written
 * `- **New for providers:` and needs none.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TIPS } from '../src/tips/catalog.js'
import { isNewer } from '../src/tips/state.js'

const TIPS_REQUIRED_FROM = '1.72.0'
const ROOT = resolve(__dirname, '..')

function changelogFeatures(): Array<{ version: string; line: string }> {
  const out: Array<{ version: string; line: string }> = []
  let version = ''
  for (const line of readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8').split('\n')) {
    const heading = /^## (\d+\.\d+\.\d+)/.exec(line)
    if (heading) version = heading[1]!
    if (line.startsWith('- **New:')) out.push({ version, line: line.slice(0, 80) })
  }
  return out
}

describe('the tip catalog', () => {
  it('has a tip for every released feature', () => {
    const required = changelogFeatures().filter((f) => !isNewer(TIPS_REQUIRED_FROM, f.version))
    expect(required.length).toBeGreaterThan(0)
    for (const f of required) {
      const has = TIPS.some((t) => t.since === f.version)
      expect(has, `${f.version} "${f.line}" needs a tip in src/tips/catalog.ts, or write it as "- **New for providers:"`).toBe(true)
    }
  })

  it('gives every tip a way to tell it has been tried', () => {
    for (const t of TIPS) expect(!!t.used || !!t.commands?.length || !!t.phrases, t.id).toBe(true)
  })

  it('has unique ids and short, finished wording', () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length)
    for (const t of TIPS) {
      expect(t.text.length, t.id).toBeLessThanOrEqual(170)
      expect(t.tryIt.length, t.id).toBeLessThanOrEqual(90)
      expect(`${t.text}${t.tryIt}`, t.id).not.toMatch(/[—–<>]/)
    }
  })

  it('names only commands that exist', () => {
    const menu = readFileSync(resolve(ROOT, 'src/bot.ts'), 'utf-8')
    for (const t of TIPS) for (const c of t.commands ?? []) expect(menu, `${t.id}: ${c}`).toContain(`command: '${c.slice(1)}'`)
  })

  it('says how to turn on a feature that starts off, and never does it', () => {
    const off = TIPS.filter((t) => t.text.includes('off until you turn it on'))
    expect(off.length).toBeGreaterThanOrEqual(4)
    for (const t of off) expect(t.tryIt).toMatch(/turn on/)
  })
})
