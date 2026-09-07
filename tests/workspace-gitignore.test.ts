import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'

describe('workspace plumbing', () => {
  it('gitignores workspaces/ so a clone is never committed into the assistant repo', () => {
    const ignore = readFileSync(resolve(PROJECT_ROOT, '.gitignore'), 'utf-8').split('\n')
    expect(ignore).toContain('workspaces/')
  })
  it('exposes the workspace CLI as an npm script', () => {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts.workspace).toBe('tsx scripts/workspace.ts')
  })
})
