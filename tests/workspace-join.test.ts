import { describe, it, expect, vi } from 'vitest'
import { runJoin, rewriteRepoUrl, sshConfigBlock } from '../src/workspace/join.js'
import type { JoinIO } from '../src/workspace/join.js'

function fakeIO(over: Partial<JoinIO> = {}): JoinIO & { config: string[] } {
  const config: string[] = []
  return {
    config,
    keyExists: () => false,
    generateKey: vi.fn(async () => {}),
    readPublicKey: () => 'ssh-ed25519 AAAA joy@havn',
    sshConfigHas: () => false,
    appendSshConfig: (b) => { config.push(b) },
    gitLsRemote: async () => true,
    gitClone: async () => ({ ok: true, out: '' }),
    gitConfig: vi.fn(async () => {}),
    readManifest: () => '---\nname: havn\nshared-with: partner\nmembers: [Marc + Umi (owner)]\n---',
    dirExists: () => false,
    ...over,
  }
}

const opts = {
  name: 'havn', repo: 'git@github.com:els-partners/havn-workspace.git',
  dir: '/root/workspaces/havn', keyPath: '/home/h/.ssh/havn-workspace-havn', owner: 'Marina Alex', assistant: 'Joy',
}

describe('rewriteRepoUrl / sshConfigBlock', () => {
  it('routes the scp-style url through the alias', () => {
    expect(rewriteRepoUrl('git@github.com:o/r.git', 'havn-ws-havn')).toBe('git@havn-ws-havn:o/r.git')
    expect(rewriteRepoUrl('ssh://git@github.com/o/r.git', 'havn-ws-havn')).toBe('ssh://git@havn-ws-havn/o/r.git')
  })
  it('pins the key and host in the config block', () => {
    const b = sshConfigBlock('havn-ws-havn', '/k')
    expect(b).toContain('Host havn-ws-havn')
    expect(b).toContain('HostName github.com')
    expect(b).toContain('IdentityFile /k')
    expect(b).toContain('IdentitiesOnly yes')
  })
})

describe('runJoin', () => {
  it('first run: creates key and config, returns key-ready without cloning', async () => {
    const clone = vi.fn(async () => ({ ok: true, out: '' }))
    const io = fakeIO({ gitClone: clone, gitLsRemote: async () => false })
    const r = await runJoin(io, opts)
    expect(r).toEqual({ stage: 'key-ready', publicKey: 'ssh-ed25519 AAAA joy@havn', created: true })
    expect(io.generateKey).toHaveBeenCalledWith(opts.keyPath, 'joy@havn-workspace-havn')
    expect(io.config).toHaveLength(1)
    expect(clone).not.toHaveBeenCalled()
  })

  it('second run with key present but access still denied returns access-denied', async () => {
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true, gitLsRemote: async () => false })
    const r = await runJoin(io, opts)
    expect(r.stage).toBe('access-denied')
  })

  it('second run with access clones, sets identity, reads the manifest', async () => {
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true })
    const r = await runJoin(io, opts)
    expect(r.stage).toBe('joined')
    if (r.stage === 'joined') expect(r.manifest.sharedWith).toBe('partner')
    expect(io.gitConfig).toHaveBeenCalledWith(opts.dir, 'user.name', 'Joy (Marina Alex)')
    expect(io.gitConfig).toHaveBeenCalledWith(opts.dir, 'user.email', 'joy@havn.noreply')
  })

  it('warns and marks unknown when WORKSPACE.md is missing', async () => {
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true, readManifest: () => null })
    const r = await runJoin(io, opts)
    expect(r.stage).toBe('joined')
    if (r.stage === 'joined') {
      expect(r.manifest.sharedWith).toBe('unknown')
      expect(r.warning).toMatch(/WORKSPACE.md/)
    }
  })

  it('skips the clone when the directory already exists', async () => {
    const clone = vi.fn(async () => ({ ok: true, out: '' }))
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true, dirExists: () => true, gitClone: clone })
    const r = await runJoin(io, opts)
    expect(r.stage).toBe('joined')
    expect(clone).not.toHaveBeenCalled()
  })

  it('reports a failed clone', async () => {
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true, gitClone: async () => ({ ok: false, out: 'boom' }) })
    const r = await runJoin(io, opts)
    expect(r).toEqual({ stage: 'clone-failed', message: 'boom' })
  })
})
