import { describe, it, expect, vi } from 'vitest'
import { findSuspiciousPaths, containsPrivateKey, findOversize, runDailySync } from '../src/sync/daily-sync.js'
import type { SyncIO } from '../src/sync/daily-sync.js'

describe('findSuspiciousPaths', () => {
  it('flags secret-looking staged paths', () => {
    const paths = [
      '.env',
      'config/.env.production',
      'certs/server.pem',
      'app.key',
      'ssh/id_rsa',
      'secrets/tokens.txt',
      'my-api-key',
    ]
    expect(findSuspiciousPaths(paths)).toEqual(paths)
  })

  it('allows template env files and ordinary code', () => {
    expect(
      findSuspiciousPaths(['.env.example', 'docs/.env.sample', '.env.template', 'src/index.ts', 'README.md'])
    ).toEqual([])
  })
})

describe('containsPrivateKey', () => {
  it('detects private key headers of every flavor', () => {
    for (const kind of ['OPENSSH', 'RSA', 'DSA', 'EC', 'PGP']) {
      expect(containsPrivateKey(`-----BEGIN ${kind} PRIVATE KEY-----\nabc`)).toBe(true)
    }
  })

  it('passes ordinary content', () => {
    expect(containsPrivateKey('const key = "not a private key"')).toBe(false)
  })
})

describe('findOversize', () => {
  it('blocks files at the 95MB guard (GitHub hard-rejects at 100MB)', () => {
    const entries = [
      { path: 'ok.bin', size: 10 * 1024 * 1024 },
      { path: 'huge.bin', size: 96 * 1024 * 1024 },
    ]
    expect(findOversize(entries).map((e) => e.path)).toEqual(['huge.bin'])
  })
})

/** Scripted fake git: matches on the joined arg prefix, in order of declaration. */
function fakeGit(script: Record<string, { ok?: boolean; out?: string }>) {
  const calls: string[] = []
  const git = vi.fn(async (...args: string[]) => {
    const cmd = args.join(' ')
    calls.push(cmd)
    for (const [prefix, res] of Object.entries(script)) {
      if (cmd.startsWith(prefix)) return { ok: res.ok ?? true, out: res.out ?? '' }
    }
    return { ok: true, out: '' }
  })
  return { git, calls }
}

function io(git: SyncIO['git'], files: Record<string, { content?: string; size?: number }> = {}): SyncIO {
  return {
    git,
    readFile: (p) => files[p]?.content ?? null,
    fileSize: (p) => files[p]?.size ?? 0,
    log: () => {},
  }
}

describe('runDailySync', () => {
  it('clean tree: fetch + rebase only, no commit, no push', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref HEAD': { out: 'main\n' },
      'status --porcelain': { out: '' },
      'rev-list --count': { out: '0\n' },
    })
    const result = await runDailySync(io(git), { branch: 'main', remote: 'origin', date: '2026-07-25', host: 'test' })
    expect(result.ok).toBe(true)
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
    expect(calls.some((c) => c.startsWith('push'))).toBe(false)
  })

  it('drift: stages, commits with the auto-sync message, pushes', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref HEAD': { out: 'main\n' },
      'status --porcelain': { out: ' M STATE.md\n' },
      'diff --cached --name-only': { out: 'STATE.md\n' },
      'rev-list --count': { out: '1\n' },
    })
    const result = await runDailySync(io(git, { 'STATE.md': { content: 'notes', size: 10 } }), {
      branch: 'main', remote: 'origin', date: '2026-07-25', host: 'macmini',
    })
    expect(result.ok).toBe(true)
    expect(calls).toContain('add -A')
    expect(calls.some((c) => c.startsWith('commit -m auto-sync: 2026-07-25 (macmini)'))).toBe(true)
    expect(calls.some((c) => c.startsWith('push origin main'))).toBe(true)
  })

  it('aborts and resets when a staged file looks like a secret', async () => {
    const { git, calls } = fakeGit({
      'rev-parse --abbrev-ref HEAD': { out: 'main\n' },
      'status --porcelain': { out: '?? .env\n' },
      'diff --cached --name-only': { out: '.env\n' },
    })
    const result = await runDailySync(io(git, { '.env': { content: 'TOKEN=x', size: 10 } }), {
      branch: 'main', remote: 'origin', date: '2026-07-25', host: 'test',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('.env')
    expect(calls).toContain('reset')
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
  })

  it('refuses to run on the wrong branch', async () => {
    const { git } = fakeGit({ 'rev-parse --abbrev-ref HEAD': { out: 'feat/x\n' } })
    const result = await runDailySync(io(git), { branch: 'main', remote: 'origin', date: 'd', host: 'h' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('feat/x')
  })
})
