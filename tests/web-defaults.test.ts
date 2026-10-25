import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelAlias, defaultEffort, pickerDefaults } from '../src/web/defaults.js'

const dirs: string[] = []
function tree(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'web-defaults-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), JSON.stringify(body))
  }
  return root
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('modelAlias', () => {
  it('maps aliases and full ids, and rejects the rest', () => {
    expect(modelAlias('sonnet')).toBe('sonnet')
    expect(modelAlias('claude-sonnet-4-5')).toBe('sonnet')
    expect(modelAlias('claude-opus-5-5')).toBe('opus')
    expect(modelAlias('gpt-6')).toBeNull()
    expect(modelAlias(undefined)).toBeNull()
  })
})

describe('defaultEffort', () => {
  it('reads the user setting the SDK would load', () => {
    const home = tree({ '.claude/settings.json': { effortLevel: 'xhigh' } })
    expect(defaultEffort(tree({}), home)).toBe('xhigh')
  })
  it('lets project settings beat user settings, local beat both', () => {
    const home = tree({ '.claude/settings.json': { effortLevel: 'xhigh' } })
    expect(defaultEffort(tree({ '.claude/settings.json': { effortLevel: 'high' } }), home)).toBe('high')
    const root = tree({ '.claude/settings.json': { effortLevel: 'high' }, '.claude/settings.local.json': { effortLevel: 'low' } })
    expect(defaultEffort(root, home)).toBe('low')
  })
  it('is null when nothing sets one or the value is not a known level', () => {
    expect(defaultEffort(tree({}), tree({}))).toBeNull()
    expect(defaultEffort(tree({}), tree({ '.claude/settings.json': { effortLevel: 'max' } }))).toBeNull()
  })
})

describe('pickerDefaults', () => {
  it('prefers the chat /model choice over the pinned model', () => {
    const none = tree({})
    expect(pickerDefaults('haiku', 'claude-sonnet-4-5', none, none).model).toBe('haiku')
    expect(pickerDefaults(undefined, 'claude-sonnet-4-5', none, none).model).toBe('sonnet')
  })
})
