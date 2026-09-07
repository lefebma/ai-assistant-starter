import { describe, it, expect, vi } from 'vitest'
import { runWorkspaceSync } from '../src/workspace/sync.js'
import type { SyncIO } from '../src/sync/daily-sync.js'

/** git path lists are read with -z, so the fake speaks NUL too. */
function z(...paths: string[]): string {
  return paths.map((p) => `${p}\0`).join('')
}

/**
 * `index` models a real index: a successful `git reset -q -- <path>` removes
 * the path, so the post-drop re-read sees the shorter list. Scripts that pass
 * a static 'diff --cached --name-only' instead model an index that never
 * changes, which is the C1 failure mode.
 */
function fakeGit(script: Record<string, { ok?: boolean; out?: string }>, index?: string[]) {
  const calls: string[] = []
  const staged = index ? [...index] : null
  const git = vi.fn(async (...args: string[]) => {
    const cmd = args.join(' ')
    calls.push(cmd)
    if (staged) {
      if (cmd.startsWith('diff --cached --name-only')) return { ok: true, out: z(...staged) }
      const m = cmd.match(/^reset -q -- (.*)$/)
      if (m) {
        const i = staged.indexOf(m[1])
        if (i >= 0) staged.splice(i, 1)
        return { ok: true, out: '' }
      }
    }
    for (const [prefix, res] of Object.entries(script)) {
      if (cmd.startsWith(prefix)) return { ok: res.ok ?? true, out: res.out ?? '' }
    }
    return { ok: true, out: '' }
  })
  return { git, calls }
}

function io(git: SyncIO['git'], files: Record<string, string | null> = {}, rebasing = false): SyncIO {
  return {
    git,
    readFile: (p) => (p in files ? files[p] : ''),
    fileSize: () => 10,
    log: () => {},
    rebaseInProgress: () => rebasing,
  }
}

const opts = { assistant: 'Joy', privatePatterns: ['$649.35'] }

describe('runWorkspaceSync', () => {
  it('commits staged markdown with the assistant prefix, then pulls and pushes', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': { out: ' M projects/gtm/STATE.md\n' },
      'diff --cached --name-only': { out: z('projects/gtm/STATE.md') },
      'rev-list --count': { out: '1\n' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(true)
    expect(r.committed).toBe(true)
    expect(r.pushed).toBe(true)
    expect(calls).toContain('commit -m joy: update projects/gtm/STATE.md')
    expect(calls).toContain('pull --rebase origin main')
    expect(calls).toContain('push origin main')
    // Commit before pull, pull before the ahead count, ahead count before push.
    const at = (c: string): number => calls.findIndex((x) => x.startsWith(c))
    expect(at('commit')).toBeLessThan(at('pull --rebase'))
    expect(at('pull --rebase')).toBeLessThan(at('rev-list --count'))
    expect(at('rev-list --count')).toBeLessThan(at('push'))
  })

  it('unstages a file that matches a private pattern and still commits the rest', async () => {
    const { git, calls } = fakeGit({
      'status --porcelain': { out: ' M a.md\n M b.md\n' },
      'rev-list --count': { out: '1\n' },
    }, ['a.md', 'b.md'])
    const r = await runWorkspaceSync(io(git, { 'a.md': 'wholesale $649.35', 'b.md': 'fine' }), opts)
    expect(r.unstaged).toEqual([{ path: 'a.md', reason: 'matches a private pattern' }])
    expect(calls).toContain('reset -q -- a.md')
    expect(calls).toContain('commit -m joy: update b.md')
  })

  it('unstages a binary outside inbox/ and a secret-looking path', async () => {
    const { git } = fakeGit({
      'status --porcelain': { out: '?? deck.pptx\n?? .env\n?? inbox/deck.pptx\n' },
      'rev-list --count': { out: '1\n' },
    }, ['deck.pptx', '.env', 'inbox/deck.pptx'])
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.unstaged.map((u) => u.path).sort()).toEqual(['.env', 'deck.pptx'])
  })

  it('reads NUL-separated paths literally, so a path with a space or quote is dropped by its real name', async () => {
    const path = "Marina's draft.pptx"
    const { git, calls } = fakeGit({
      'status --porcelain': { out: '?? x\n' },
      'rev-list --count': { out: '1\n' },
    }, [path, 'ok.md'])
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.unstaged.map((u) => u.path)).toEqual([path])
    expect(calls).toContain(`reset -q -- ${path}`)
    expect(calls).toContain('commit -m joy: update ok.md')
  })

  it('aborts the whole sync when an unstage fails, rather than reporting a hold-back', async () => {
    let seen = 0
    const git = vi.fn(async (...args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.startsWith('status --porcelain')) return { ok: true, out: '?? deck.pptx\n' }
      if (cmd.startsWith('diff --cached --name-only')) { seen++; return { ok: true, out: z('deck.pptx', 'ok.md') } }
      if (cmd.startsWith('reset -q --')) return { ok: false, out: 'fatal: pathspec did not match' }
      return { ok: true, out: '' }
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/could not unstage deck\.pptx/)
    expect(r.committed).toBe(false)
    expect(r.pushed).toBe(false)
    const calls = git.mock.calls.map((c) => c.join(' '))
    expect(calls).toContain('reset')
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
    expect(calls.some((c) => c.startsWith('push'))).toBe(false)
    expect(seen).toBe(1)
  })

  it('aborts when a dropped path is still staged after the reset reported success', async () => {
    // git quoting behaviour: reset exits 0 but the file never leaves the index.
    const git = vi.fn(async (...args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.startsWith('status --porcelain')) return { ok: true, out: '?? deck.pptx\n' }
      if (cmd.startsWith('diff --cached --name-only')) return { ok: true, out: z('deck.pptx', 'ok.md') }
      return { ok: true, out: '' }
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/still staged after unstaging: deck\.pptx/)
    const calls = git.mock.calls.map((c) => c.join(' '))
    expect(calls).toContain('reset')
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
    expect(calls.some((c) => c.startsWith('push'))).toBe(false)
  })

  it('reports a rebase conflict, leaves markers, and does not push', async () => {
    const { git, calls } = fakeGit({
      'pull --rebase': { ok: false, out: 'CONFLICT' },
      'diff --name-only --diff-filter=U': { out: z('projects/gtm/STATE.md') },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe('projects/gtm/STATE.md')
    expect(calls.some((c) => c.startsWith('push'))).toBe(false)
    expect(calls.some((c) => c.startsWith('rebase --abort'))).toBe(false)
  })

  it('reports a pull failure with no unmerged paths verbatim, with no conflict field', async () => {
    const { git } = fakeGit({
      'pull --rebase': { ok: false, out: 'fatal: could not read Username for https://github.com\n' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBeUndefined()
    expect(r.message).toMatch(/could not read Username/)
  })

  it('treats a failed pull as a conflict when a rebase is left in progress', async () => {
    const { git } = fakeGit({ 'pull --rebase': { ok: false, out: 'error' } })
    const r = await runWorkspaceSync(io(git, {}, true), opts)
    expect(r.message).toBe('rebase in progress, needs a human')
  })

  it('reports a pre-existing in-progress rebase before touching anything', async () => {
    const { git, calls } = fakeGit({ 'diff --name-only --diff-filter=U': { out: z('a.md') } })
    const r = await runWorkspaceSync(io(git, {}, true), opts)
    expect(r).toMatchObject({ ok: false, message: 'rebase in progress, needs a human', conflict: 'a.md' })
    expect(calls.some((c) => c.startsWith('add'))).toBe(false)
    expect(calls.some((c) => c.startsWith('pull'))).toBe(false)
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
      'diff --cached --name-only': { out: z('a.md') },
      'rev-list --count': { out: '1\n' },
      'push': { ok: false, out: 'denied' },
    })
    const r = await runWorkspaceSync(io(git), opts)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/push/)
  })
})
