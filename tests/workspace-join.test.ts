import { describe, it, expect, vi } from 'vitest'
import { ensureIncludeLine, knownHostsHas, runJoin, rewriteRepoUrl, sshConfigBlock, validateRepoUrl } from '../src/workspace/join.js'
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
    ensureKnownHost: vi.fn(async () => ({ ok: true })),
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
    expect(b).toContain('IdentityAgent none')
  })
})

describe('knownHostsHas', () => {
  it('matches a plain host line', () => {
    expect(knownHostsHas('github.com ssh-ed25519 AAAA\n', 'github.com')).toBe(true)
  })
  it('matches a [host]:port line', () => {
    expect(knownHostsHas('[git.example.com]:22 ssh-ed25519 AAAA\n', 'git.example.com')).toBe(true)
  })
  it('cannot match a hashed line, so it proceeds to append', () => {
    expect(knownHostsHas('|1|abcd1234=|efgh5678= ssh-ed25519 AAAA\n', 'github.com')).toBe(false)
  })
  it('returns false for a non-matching file', () => {
    expect(knownHostsHas('gitlab.com ssh-ed25519 AAAA\n', 'github.com')).toBe(false)
  })
})

describe('ensureIncludeLine', () => {
  const line = 'Include ~/.ssh/havn-workspaces.conf'

  it('prepends the include ahead of an existing Host * stanza', () => {
    const out = ensureIncludeLine('Host *\n  IdentityFile ~/.ssh/id_ed25519\n', line)
    expect(out.split('\n')[0]).toBe(line)
    expect(out).toContain('Host *')
  })

  it('creates the file content when there is nothing there yet', () => {
    expect(ensureIncludeLine('', line)).toBe(`${line}\n`)
  })

  it('never duplicates an include that is already present', () => {
    const existing = `${line}\n\nHost *\n`
    expect(ensureIncludeLine(existing, line)).toBe(existing)
    expect(ensureIncludeLine(`  ${line}  \nHost *\n`, line)).toBe(`  ${line}  \nHost *\n`)
  })
})

describe('validateRepoUrl', () => {
  it('accepts scp-style and ssh:// urls', () => {
    expect(validateRepoUrl('git@github.com:els-partners/havn-workspace.git')).toEqual({ ok: true, host: 'github.com' })
    expect(validateRepoUrl('ssh://git@git.example.co.uk/org/repo.git')).toEqual({ ok: true, host: 'git.example.co.uk' })
  })

  it('rejects https, which used to be rewritten into a broken url and blamed on the deploy key', () => {
    const r = validateRepoUrl('https://github.com/o/r.git')
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toMatch(/SSH URLs only/)
  })

  it('rejects a newline, which would inject directives into ~/.ssh/config', () => {
    expect(validateRepoUrl('git@github.com\nHost *\n  IdentityFile /etc/x:o/r.git').ok).toBe(false)
    expect(validateRepoUrl('git@github.com:o/r.git\n  ProxyCommand touch /tmp/pwned').ok).toBe(false)
  })

  it('rejects a leading dash, which git would read as a flag', () => {
    expect(validateRepoUrl('--upload-pack=touch /tmp/pwned').ok).toBe(false)
    expect(validateRepoUrl('-git@github.com:o/r.git').ok).toBe(false)
  })

  it('rejects other shapes', () => {
    expect(validateRepoUrl('').ok).toBe(false)
    expect(validateRepoUrl('github.com:o/r.git').ok).toBe(false)
    expect(validateRepoUrl('root@github.com:o/r.git').ok).toBe(false)
    expect(validateRepoUrl('git@github.com:../../etc/passwd').ok).toBe(false)
  })
})

describe('runJoin', () => {
  it('refuses an invalid repo url even when called directly', async () => {
    const io = fakeIO()
    const r = await runJoin(io, { ...opts, repo: 'https://github.com/o/r.git' })
    expect(r).toMatchObject({ stage: 'clone-failed' })
    expect(io.config).toHaveLength(0)
  })

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

  it('returns host-unverified and never calls gitLsRemote or gitClone when the host key cannot be verified', async () => {
    const lsRemote = vi.fn(async () => true)
    const clone = vi.fn(async () => ({ ok: true, out: '' }))
    const io = fakeIO({
      keyExists: () => true, sshConfigHas: () => true,
      ensureKnownHost: vi.fn(async () => ({ ok: false, message: 'ssh-keyscan timed out' })),
      gitLsRemote: lsRemote, gitClone: clone,
    })
    const r = await runJoin(io, opts)
    expect(r).toEqual({ stage: 'host-unverified', message: 'ssh-keyscan timed out' })
    expect(lsRemote).not.toHaveBeenCalled()
    expect(clone).not.toHaveBeenCalled()
  })

  it('calls ensureKnownHost with the host parsed from the repo url', async () => {
    const ensureKnownHost = vi.fn(async () => ({ ok: true }))
    const io = fakeIO({ keyExists: () => true, sshConfigHas: () => true, ensureKnownHost })
    await runJoin(io, { ...opts, repo: 'git@github.com:o/r.git' })
    expect(ensureKnownHost).toHaveBeenCalledWith('github.com')
  })
})
