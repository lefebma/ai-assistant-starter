import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadRegistry, saveRegistry, upsertWorkspace, removeWorkspace, getWorkspace, workspaceDir,
} from '../src/workspace/registry.js'
import type { WorkspaceEntry } from '../src/workspace/types.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-registry-'))
  return () => rmSync(dir, { recursive: true, force: true })
})

const havn: WorkspaceEntry = {
  name: 'havn',
  repo: 'git@github.com:els-partners/havn-workspace.git',
  path: '',
  syncMinutes: 30,
  enabled: true,
  chatIds: [],
  failures: 0,
}

describe('workspace registry', () => {
  it('returns an empty list when the file is missing', () => {
    expect(loadRegistry(dir)).toEqual([])
  })

  it('round-trips entries and defaults path to workspaces/<name>', () => {
    upsertWorkspace(havn, dir)
    const back = loadRegistry(dir)
    expect(back).toHaveLength(1)
    expect(back[0].name).toBe('havn')
    expect(workspaceDir(back[0], '/root')).toBe('/root/workspaces/havn')
  })

  it('upsert replaces by name and remove reports whether it existed', () => {
    upsertWorkspace(havn, dir)
    upsertWorkspace({ ...havn, syncMinutes: 10 }, dir)
    expect(loadRegistry(dir)).toHaveLength(1)
    expect(getWorkspace('havn', dir)?.syncMinutes).toBe(10)
    expect(removeWorkspace('havn', dir)).toBe(true)
    expect(removeWorkspace('havn', dir)).toBe(false)
  })

  it('ignores a corrupt file rather than throwing', () => {
    writeFileSync(join(dir, 'workspaces.json'), '{not json')
    expect(loadRegistry(dir)).toEqual([])
  })

  it('writes pretty JSON so a human can read the store file', () => {
    saveRegistry([havn], dir)
    expect(readFileSync(join(dir, 'workspaces.json'), 'utf-8')).toContain('\n  ')
  })
})
