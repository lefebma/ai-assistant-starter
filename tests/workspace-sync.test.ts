import { describe, it, expect, vi } from 'vitest'
import { runWorkspaceSync } from '../src/workspace/sync.js'
import type { SyncIO } from '../src/sync/daily-sync.js'

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

function io(git: SyncIO['git'], files: Record<string, string | null> = {}): SyncIO {
  return {
    git,
    readFile: (p) => (p in files ? files[p] : ''),
    fileSize: () => 10,
    log: () => {},
  }
}

const opts = { assistant: 'Joy', privatePatterns: ['$649.35'] }

describe('runWorkspaceSync', () => {
  it('pulls, commits staged markdown with the assistant prefix, and pushes', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': { out: ' M projects/gtm/STATE.md\n' },
      'diff --cached --name-only': { out: 'projects/gtm/STATE.md\n' },
      'rev-list --count': { out: '1\n' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(true)
    expect(r.committed).toBe(true)
    expect(r.pushed).toBe(true)
    expect(calls[0]).toBe('pull --rebase origin main')
    expect(calls).toContain('commit -m joy: update projects/gtm/STATE.md')
    expect(calls).toContain('push origin main')
  })

  it('unstages a file that matches a private pattern and still commits the rest', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': { out: ' M a.md\n M b.md\n' },
      'diff --cached --name-only': { out: 'a.md\nb.md\n' },
      'rev-list --count': { out: '1\n' },
    })
    const r = await runWorkspaceSync(io(git, { 'a.md': 'wholesale $649.35', 'b.md': 'fine' }), opts)
    expect(r.unstaged).toEqual([{ path: 'a.md', reason: 'matches a private pattern' }])
    expect(calls).toContain('reset -q -- a.md')
    expect(calls).toContain('commit -m joy: update b.md')
  })

  it('unstages a binary outside inbox/ and a secret-looking path', async () => {
    const { git } = fakeGit({
      'status --porcelain': { out: '?? deck.pptx\n?? .env\n?? inbox/deck.pptx\n' },
      'diff --cached --name-only': { out: 'deck.pptx\n.env\ninbox/deck.pptx\n' },
      'rev-list --count': { out: '1\n' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.unstaged.map((u) => u.path).sort()).toEqual(['.env', 'deck.pptx'])
  })

  it('reports a rebase conflict, leaves markers, and does not push', async () => {
    const { git, calls } = fakeGit({
      'pull --rebase': { ok: false, out: 'CONFLICT' },
      'diff --name-only --diff-filter=U': { out: 'projects/gtm/STATE.md\n' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe('projects/gtm/STATE.md')
    expect(calls.some((c) => c.startsWith('push'))).toBe(false)
    expect(calls.some((c) => c.startsWith('rebase --abort'))).toBe(false)
  })

  it('is a no-op when clean and up to date', async () => {
    const { git, calls } = fakeGit({ 'rev-list --count': { out: '0\n' } })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r).toMatchObject({ ok: true, committed: false, pushed: false })
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
  })

  it('fails when push is refused', async () => {
    const { git } = fakeGit({
      'status --porcelain': { out: ' M a.md\n' },
      'diff --cached --name-only': { out: 'a.md\n' },
      'rev-list --count': { out: '1\n' },
      'push': { ok: false, out: 'denied' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/push/)
  })
})
