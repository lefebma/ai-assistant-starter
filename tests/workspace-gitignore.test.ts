import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'

describe('workspace plumbing', () => {
  it('gitignores workspace clones but backs up the private-pattern list', () => {
    const ignore = readFileSync(resolve(PROJECT_ROOT, '.gitignore'), 'utf-8').split(/\r?\n/)
    expect(ignore).toContain('workspaces/*')
    expect(ignore).toContain('!workspaces/.private-patterns')
    // The negation only bites if the directory itself is not excluded.
    expect(ignore).not.toContain('workspaces/')
  })
  it('exposes the workspace CLI as an npm script', () => {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'))
    expect(pkg.scripts.workspace).toBe('tsx scripts/workspace.ts')
  })
})
