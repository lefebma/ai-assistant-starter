import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceProvider, RULES } from '../src/memory/providers/workspace.js'
import { saveRegistry } from '../src/workspace/registry.js'
import type { WorkspaceEntry } from '../src/workspace/types.js'

let root: string
let store: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-prov-root-'))
  store = mkdtempSync(join(tmpdir(), 'ws-prov-store-'))
  mkdirSync(join(root, 'workspaces', 'havn', 'projects', 'gtm'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'havn', 'projects', 'gtm', 'STATE.md'), '---\nname: GTM\n---\nOrlando launch is the milestone.')
  mkdirSync(join(root, 'workspaces', 'els', 'projects', 'website'), { recursive: true })
  writeFileSync(join(root, 'workspaces', 'els', 'projects', 'website', 'STATE.md'), '---\nname: Website\n---\nAstro migration phase 1.')
  const havn: WorkspaceEntry = {
    name: 'havn', repo: 'x', path: '', syncMinutes: 30, enabled: true, chatIds: ['-100777'], failures: 0,
    manifest: { name: 'havn', sharedWith: 'partner', boards: [], members: [
      { human: 'Marc Lefebvre', assistant: 'Umi', role: 'owner' }, { human: 'Marina Alex', assistant: 'Joy', role: 'partner' },
    ] },
  }
  const els: WorkspaceEntry = {
    name: 'els', repo: 'y', path: '', syncMinutes: 30, enabled: true, chatIds: [], failures: 0,
    manifest: { name: 'els', sharedWith: 'internal', boards: [], members: [
      { human: 'Marc Lefebvre', assistant: 'Umi', role: 'owner' }, { human: 'Walid Esefan', assistant: '', role: 'partner' },
    ] },
  }
  saveRegistry([havn, els], store)
  return () => { rmSync(root, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }) }
})

describe('WorkspaceProvider', () => {
  it('returns nothing for an unrelated message', async () => {
    const p = new WorkspaceProvider({ storeDir: store, root })
    expect(await p.retrieve('1', 'what is the weather')).toEqual([])
  })

  it('routes a Marina mention to havn only, with banner, state and rules', async () => {
    const p = new WorkspaceProvider({ storeDir: store, root })
    const frags = await p.retrieve('1', 'what did Marina add to the gtm plan')
    const text = frags.map((f) => f.content).join('\n')
    expect(text).toContain('SHARED WORKSPACE "havn" (partner)')
    expect(text).toContain('Marina Alex + Joy')
    expect(text).toContain('Orlando launch')
    expect(text).not.toContain('Astro migration')
    expect(frags.some((f) => f.content === RULES)).toBe(true)
  })

  it('routes a Walid mention to els only', async () => {
    const p = new WorkspaceProvider({ storeDir: store, root })
    const text = (await p.retrieve('1', "Walid's review of the website")).map((f) => f.content).join('\n')
    expect(text).toContain('SHARED WORKSPACE "els" (internal)')
    expect(text).not.toContain('"havn"')
  })

  it('injects both when both match, and rules only once', async () => {
    const p = new WorkspaceProvider({ storeDir: store, root })
    const frags = await p.retrieve('1', 'status update for Marina and Walid')
    const text = frags.map((f) => f.content).join('\n')
    expect(text).toContain('"havn"')
    expect(text).toContain('"els"')
    expect(frags.filter((f) => f.content === RULES)).toHaveLength(1)
  })

  it('uses the chat-id hint without a keyword', async () => {
    const p = new WorkspaceProvider({ storeDir: store, root })
    const text = (await p.retrieve('-100777', 'thoughts on this?')).map((f) => f.content).join('\n')
    expect(text).toContain('"havn"')
    expect(text).toContain('Orlando launch')
  })

  it('applies the unknown banner when there is no manifest', async () => {
    saveRegistry([{ name: 'raw', repo: 'z', path: '', syncMinutes: 30, enabled: true, chatIds: [], failures: 0 }], store)
    const p = new WorkspaceProvider({ storeDir: store, root })
    const text = (await p.retrieve('1', 'raw workspace status')).map((f) => f.content).join('\n')
    expect(text).toContain('(unknown)')
    expect(text).toContain('Do not write')
  })
})
