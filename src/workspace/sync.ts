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
 * Path lists always come back NUL-separated. `git diff --name-only` C-quotes
 * any path with a non-ASCII byte, a quote, a backslash or a newline in it
 * ("caf\303\251.pdf"), and that quoted form does not match the real path as a
 * pathspec, so a guard hit would be reported as held back while staying in the
 * index. With -z the bytes are literal and `git reset -- <path>` matches.
 */
async function pathList(io: SyncIO, args: string[]): Promise<string[]> {
  const r = await io.git(...args)
  return r.out.split('\0').filter(Boolean)
}

const stagedPaths = (io: SyncIO): Promise<string[]> => pathList(io, ['diff', '--cached', '--name-only', '-z'])
const conflictedPaths = (io: SyncIO): Promise<string[]> =>
  pathList(io, ['diff', '--name-only', '--diff-filter=U', '-z'])

function rebaseInProgress(io: SyncIO): boolean {
  return io.rebaseInProgress ? io.rebaseInProgress() : false
}

/**
 * One sync pass over a workspace clone: stage, run every guard (each hit is
 * unstaged and named, never a silent drop), commit under the assistant's name,
 * then pull --rebase and push.
 *
 * Commit comes before the pull because the assistant writes plain files and
 * they are committed by the next sync, so the worktree is dirty on every run
 * that has anything to say, and `git pull --rebase` refuses to run on a dirty
 * worktree. Pulling after the commit also means a pull failure with unmerged
 * paths is a real conflict rather than a dirty tree wearing a conflict's face.
 * Every guard still runs ahead of any network operation.
 *
 * A guard drop deliberately leaves a tracked, modified file unstaged, which is
 * still a dirty worktree as far as `git pull --rebase` is concerned. `--autostash`
 * stashes that held-back edit across the pull and restores it afterwards, so the
 * workspace keeps syncing instead of stalling on the one held-back file.
 */
export async function runWorkspaceSync(io: SyncIO, opts: WorkspaceSyncOptions): Promise<WorkspaceSyncResult> {
  const remote = opts.remote ?? 'origin'
  const branch = opts.branch ?? 'main'
  const unstaged: WorkspaceSyncResult['unstaged'] = []
  const base = { unstaged, committed: false, pushed: false }

  // A rebase left half-finished by a crash or a restart fails every later sync
  // in the same way. Say so plainly instead of blaming the pull.
  if (rebaseInProgress(io)) {
    const conflict = (await conflictedPaths(io))[0]
    io.log('rebase already in progress, needs a human')
    return { ...base, ok: false, message: 'rebase in progress, needs a human', ...(conflict ? { conflict } : {}) }
  }

  const dirty = (await io.git('status', '--porcelain')).out.trim().length > 0
  if (dirty) {
    await io.git('add', '-A')
    let staged = await stagedPaths(io)
    const dropped: string[] = []
    let abort: string | null = null

    // A failed unstage is a disclosure, never a successful hold-back: stop the
    // whole run, reset the index, and say nothing was pushed.
    const drop = async (path: string, reason: string): Promise<void> => {
      if (abort) return
      const reset = await io.git('reset', '-q', '--', path)
      if (!reset.ok) {
        abort = `could not unstage ${path} (${reason}), aborting sync`
        return
      }
      dropped.push(path)
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

    // Defence in depth on the one operation whose failure is a leak: re-read
    // the index and refuse to commit if anything we dropped is still in it.
    if (!abort && dropped.length > 0) {
      const after = await stagedPaths(io)
      const stuck = dropped.filter((p) => after.includes(p))
      if (stuck.length > 0) abort = `still staged after unstaging: ${stuck.join(', ')}, aborting sync`
    }

    if (abort) {
      await io.git('reset')
      io.log(abort)
      return { ...base, ok: false, message: abort }
    }

    if (staged.length > 0) {
      const commit = await io.git('commit', '-m', buildCommitSummary(opts.assistant, staged))
      if (!commit.ok) return { ...base, ok: false, message: 'git commit failed' }
      base.committed = true
    }
  }

  const pull = await io.git('pull', '--rebase', '--autostash', remote, branch)
  if (!pull.ok) {
    const conflicted = await conflictedPaths(io)
    if (conflicted.length > 0 || rebaseInProgress(io)) {
      const conflict = conflicted[0] ?? '(unknown file)'
      io.log(`rebase conflict in ${conflict}, leaving markers for a human`)
      return { ...base, ok: false, message: `rebase conflict in ${conflict}`, conflict }
    }

    // --autostash restores held-back edits into the worktree once the pull
    // succeeds. When it cannot reapply them it leaves the stash behind instead
    // of losing anything, but that needs a human: the edits are safe, not synced.
    const stashList = await io.git('stash', 'list')
    const autostashStuck =
      stashList.out.includes('autostash') || (pull.out.includes('autostash') && pull.out.includes('conflict'))
    if (autostashStuck) {
      const message = 'autostash could not be reapplied after pull; the held-back edits are in git stash, needs a human'
      io.log(message)
      return { ...base, ok: false, message }
    }

    const message = `git pull --rebase failed: ${pull.out.trim().slice(0, 200)}`
    io.log(message)
    return { ...base, ok: false, message }
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
