import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceCommand, workspaceCommandArgs } from '../src/workspace/commands.js'
import { loadRegistry } from '../src/workspace/registry.js'
import type { JoinIO } from '../src/workspace/join.js'

let store: string
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'ws-cmd-'))
  return () => rmSync(store, { recursive: true, force: true })
})

function joinIO(over: Partial<JoinIO> = {}): JoinIO {
  return {
    keyExists: () => true,
    generateKey: async () => {},
    readPublicKey: () => 'ssh-ed25519 KEY joy',
    sshConfigHas: () => true,
    appendSshConfig: () => {},
    ensureKnownHost: async () => ({ ok: true }),
    gitLsRemote: async () => true,
    gitClone: async () => ({ ok: true, out: '' }),
    gitConfig: async () => {},
    readManifest: () => '---\nname: havn\nshared-with: partner\nmembers: [Marc + Umi (owner), Marina + Joy (partner)]\n---',
    dirExists: () => false,
    ...over,
  }
}

const id = { owner: 'Marina Alex', assistant: 'Joy' }
const okSync = async () => ({ ok: true, message: 'up to date', unstaged: [], committed: false, pushed: false })

describe('workspaceCommand', () => {
  it('prints usage for unknown input', async () => {
    expect(await workspaceCommand([], { joinIO: joinIO(), storeDir: store })).toMatch(/Usage: \/workspace/)
  })

  it('rejects a bad name', async () => {
    const out = await workspaceCommand(['join', 'Bad Name', 'git@github.com:o/r.git'], { joinIO: joinIO(), storeDir: store })
    expect(out).toMatch(/lowercase/)
  })

  it('rejects a non-ssh repo url before touching the ssh config', async () => {
    const io = joinIO()
    const spy = vi.fn()
    const out = await workspaceCommand(['join', 'havn', 'https://github.com/o/r.git'], {
      joinIO: { ...io, appendSshConfig: spy }, storeDir: store, identity: id, syncOne: okSync,
    })
    expect(out).toMatch(/SSH URLs only/)
    expect(spy).not.toHaveBeenCalled()
    expect(loadRegistry(store)).toHaveLength(0)
  })

  it('first pass returns the public key and does not register', async () => {
    const out = await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], {
      joinIO: joinIO({ keyExists: () => false }), storeDir: store, identity: id, syncOne: okSync,
    })
    expect(out).toContain('ssh-ed25519 KEY joy')
    expect(out).toMatch(/deploy key/i)
    expect(loadRegistry(store)).toHaveLength(0)
  })

  it('second pass registers, syncs, and reports members', async () => {
    const out = await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], {
      joinIO: joinIO(), storeDir: store, identity: id, syncOne: okSync, root: '/r',
    })
    expect(out).toMatch(/Joined "havn"/)
    expect(out).toContain('Marina + Joy')
    const reg = loadRegistry(store)
    expect(reg).toHaveLength(1)
    expect(reg[0].manifest?.sharedWith).toBe('partner')
  })

  it('reports an unverified host key without registering the workspace', async () => {
    const io = joinIO({ ensureKnownHost: async () => ({ ok: false, message: 'ssh-keyscan timed out' }) })
    const out = await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], {
      joinIO: io, storeDir: store, identity: id, syncOne: okSync,
    })
    expect(out).toBe('Could not verify the SSH host key for github.com: ssh-keyscan timed out. Nothing was cloned.')
    expect(loadRegistry(store)).toHaveLength(0)
  })

  it('status lists workspaces with last sync', async () => {
    await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], { joinIO: joinIO(), storeDir: store, identity: id, syncOne: okSync, root: '/r' })
    const out = await workspaceCommand(['status'], { joinIO: joinIO(), storeDir: store })
    expect(out).toContain('havn')
    expect(out).toMatch(/last sync/i)
  })

  it('join puts the new workspace on a timer without a restart', async () => {
    const schedule = vi.fn()
    await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], {
      joinIO: joinIO(), storeDir: store, identity: id, syncOne: okSync, root: '/r', schedule,
    })
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toMatchObject({ name: 'havn' })
  })

  it('join does not schedule when the join stopped at key-ready', async () => {
    const schedule = vi.fn()
    await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], {
      joinIO: joinIO({ keyExists: () => false }), storeDir: store, identity: id, syncOne: okSync, schedule,
    })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('leave takes the workspace off its timer', async () => {
    await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], { joinIO: joinIO(), storeDir: store, identity: id, syncOne: okSync, root: '/r' })
    const unschedule = vi.fn()
    await workspaceCommand(['leave', 'havn'], { joinIO: joinIO(), storeDir: store, removeDir: () => {}, root: '/r', unschedule })
    expect(unschedule).toHaveBeenCalledWith('havn')
  })

  it('leave removes the entry and the clone, keeps the key', async () => {
    await workspaceCommand(['join', 'havn', 'git@github.com:o/r.git'], { joinIO: joinIO(), storeDir: store, identity: id, syncOne: okSync, root: '/r' })
    const removeDir = vi.fn()
    const out = await workspaceCommand(['leave', 'havn'], { joinIO: joinIO(), storeDir: store, removeDir, root: '/r' })
    expect(removeDir).toHaveBeenCalledWith('/r/workspaces/havn')
    expect(out).toMatch(/key .* left in place/i)
    expect(loadRegistry(store)).toHaveLength(0)
  })
})

describe('workspaceCommandArgs', () => {
  it('parses /workspace join args', () => {
    expect(workspaceCommandArgs('/workspace join havn git@github.com:o/r.git')).toEqual(['join', 'havn', 'git@github.com:o/r.git'])
  })

  it('tolerates the @BotName suffix', () => {
    expect(workspaceCommandArgs('/workspace@MyBot status')).toEqual(['status'])
  })

  it('returns empty array for bare command', () => {
    expect(workspaceCommandArgs('/workspace')).toEqual([])
  })
})
