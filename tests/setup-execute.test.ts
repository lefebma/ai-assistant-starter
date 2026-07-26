import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPlan } from '../src/setup/execute.js'

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-exec-'))
  mkdirSync(join(root, 'templates', 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'templates', 'skills', 'demo', 'manifest.json'), '{"city": "{{CITY}}"}')
  writeFileSync(join(root, 'templates', 'greet.md'), 'Hello {{OWNER_NAME}}!')
  return root
}

describe('applyPlan', () => {
  it('copies, edits with substitution, and renders templates', () => {
    const root = fixtureRoot()
    const result = applyPlan(
      [
        { type: 'copy', from: 'templates/skills/demo', to: 'skills/demo' },
        { type: 'edit', file: 'skills/demo/manifest.json', vars: { CITY: 'Toronto' } },
        { type: 'template', from: 'templates/greet.md', to: 'out/greet.md', vars: { OWNER_NAME: 'Sam' } },
      ],
      root
    )
    expect(readFileSync(join(root, 'skills/demo/manifest.json'), 'utf-8')).toBe('{"city": "Toronto"}')
    expect(readFileSync(join(root, 'out/greet.md'), 'utf-8')).toBe('Hello Sam!')
    expect(result.written).toContain('skills/demo')
  })

  it('respects onlyIfMissing and never clobbers an existing non-empty secret', () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'out'))
    writeFileSync(join(root, 'out/greet.md'), 'user-edited')
    const secretPath = join(root, 'existing-secret')
    writeFileSync(secretPath, 'REAL-KEY')

    const result = applyPlan(
      [
        { type: 'template', from: 'templates/greet.md', to: 'out/greet.md', vars: {}, onlyIfMissing: true },
        { type: 'secret', path: secretPath, value: 'NEW-KEY', note: 'n/a' },
        { type: 'secret', path: join(root, 'fresh-secret'), value: 'v1', note: 'n/a' },
        { type: 'secret', path: join(root, 'blank-secret'), value: undefined, note: 'fill me in later' },
      ],
      root
    )
    expect(readFileSync(join(root, 'out/greet.md'), 'utf-8')).toBe('user-edited')
    expect(readFileSync(secretPath, 'utf-8')).toBe('REAL-KEY')
    expect(readFileSync(join(root, 'fresh-secret'), 'utf-8')).toBe('v1')
    expect(existsSync(join(root, 'blank-secret'))).toBe(false)
    expect(result.notes).toEqual(['fill me in later'])
    expect(result.skipped).toContain(secretPath)
  })
})
