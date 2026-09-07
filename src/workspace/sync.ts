import { containsPrivateKey, findOversize, findSuspiciousPaths } from '../sync/daily-sync.js'
import type { SyncIO } from '../sync/daily-sync.js'
import { buildCommitSummary, findDisallowedTypes, findPrivatePatternHits } from './guards.js'

export interface WorkspaceSyncOptions {
  assistant: string
  privatePatterns: string[]
  remote?: string
  branch?: string
}

export interface WorkspaceSyncResult {
  ok: boolean
  message: string
  unstaged: Array<{ path: string; reason: string }>
  conflict?: string
  committed: boolean
  pushed: boolean
}

/**
 * One sync pass over a workspace clone. Pull first so local edits rebase onto
 * what the other members pushed; a conflict stops here with markers in place
 * for a human. Then stage, run every guard (each hit is unstaged and named,
 * never a silent drop), commit under the assistant's name, push.
 */
export async function runWorkspaceSync(io: SyncIO, opts: WorkspaceSyncOptions): Promise<WorkspaceSyncResult> {
  const remote = opts.remote ?? 'origin'
  const branch = opts.branch ?? 'main'
  const unstaged: WorkspaceSyncResult['unstaged'] = []
  const base = { unstaged, committed: false, pushed: false }

  const pull = await io.git('pull', '--rebase', remote, branch)
  if (!pull.ok) {
    const conflicted = (await io.git('diff', '--name-only', '--diff-filter=U')).out.split('\n').filter(Boolean)
    const conflict = conflicted[0] ?? '(unknown file)'
    io.log(`rebase conflict in ${conflict}, leaving markers for a human`)
    return { ...base, ok: false, message: `rebase conflict in ${conflict}`, conflict }
  }

  const dirty = (await io.git('status', '--porcelain')).out.trim().length > 0
  if (dirty) {
    await io.git('add', '-A')
    let staged = (await io.git('diff', '--cached', '--name-only')).out.split('\n').filter(Boolean)

    const drop = async (path: string, reason: string): Promise<void> => {
      await io.git('reset', '-q', '--', path)
      unstaged.push({ path, reason })
      staged = staged.filter((p) => p !== path)
    }

    for (const p of findSuspiciousPaths(staged)) await drop(p, 'looks like a secret')
    for (const p of findDisallowedTypes(staged)) await drop(p, 'file type not allowed outside inbox/')
    for (const p of staged.filter((s) => {
      const c = io.readFile(s)
      return c !== null && containsPrivateKey(c)
    })) await drop(p, 'contains private key material')
    for (const p of findPrivatePatternHits(staged.map((s) => ({ path: s, content: io.readFile(s) })), opts.privatePatterns)) {
      await drop(p, 'matches a private pattern')
    }
    for (const e of findOversize(staged.map((s) => ({ path: s, size: io.fileSize(s) })))) await drop(e.path, 'over 95MB')

    if (staged.length > 0) {
      const commit = await io.git('commit', '-m', buildCommitSummary(opts.assistant, staged))
      if (!commit.ok) return { ...base, ok: false, message: 'git commit failed' }
      base.committed = true
    }
  }

  const ahead = parseInt((await io.git('rev-list', '--count', `${remote}/${branch}..HEAD`)).out.trim(), 10) || 0
  if (ahead === 0) {
    return { ...base, ok: true, message: unstaged.length ? `nothing pushed, ${unstaged.length} file(s) held back` : 'up to date' }
  }

  const push = await io.git('push', remote, branch)
  if (!push.ok) return { ...base, ok: false, message: `git push failed: ${push.out.trim().slice(0, 200)}` }
  base.pushed = true
  return { ...base, ok: true, message: `pushed ${ahead} commit(s)${unstaged.length ? `, ${unstaged.length} file(s) held back` : ''}` }
}
