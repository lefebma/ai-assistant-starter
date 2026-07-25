/**
 * Daily repo sync logic — pull --rebase, auto-commit drift, push — with the
 * belt-and-braces guards the bash original earned the hard way:
 *
 *   - path scan: refuse to commit anything that LOOKS like a secret
 *   - content scan: refuse anything containing a private-key header
 *   - size scan: refuse >95MB files (GitHub hard-rejects at 100MB)
 *
 * Pure guard functions + an orchestrator over injected I/O, so every guard
 * is unit-tested and the git flow is testable without a repo. The thin CLI
 * in scripts/daily-sync.ts wires real git/fs/notify.
 */

const SUSPICIOUS_PATH = /(^|\/)(\.env$|\.env\.|.*api-key$|.*\.pem$|.*\.key$|.*key_?pair.*|id_rsa|id_ed25519|secrets?\/)/i
const ALLOWED_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i
const PRIVATE_KEY_HEADER = /BEGIN (OPENSSH|RSA|DSA|EC|PGP) PRIVATE KEY/
const MAX_FILE_BYTES = 95 * 1024 * 1024

export function findSuspiciousPaths(paths: string[]): string[] {
  return paths.filter((p) => SUSPICIOUS_PATH.test(p) && !ALLOWED_TEMPLATE.test(p))
}

export function containsPrivateKey(content: string): boolean {
  return PRIVATE_KEY_HEADER.test(content)
}

export function findOversize(entries: Array<{ path: string; size: number }>): Array<{ path: string; size: number }> {
  return entries.filter((e) => e.size > MAX_FILE_BYTES)
}

export interface SyncIO {
  /** Run git with args in the repo; never throws. */
  git(...args: string[]): Promise<{ ok: boolean; out: string }>
  /** Staged file content for the key scan; null for unreadable/binary. */
  readFile(path: string): string | null
  fileSize(path: string): number
  log(line: string): void
}

export interface SyncOptions {
  branch: string
  remote: string
  /** Injected so the commit message is deterministic under test. */
  date: string
  host: string
  pushAttempts?: number
}

export interface SyncResult {
  ok: boolean
  message: string
}

export async function runDailySync(io: SyncIO, opts: SyncOptions): Promise<SyncResult> {
  const { branch, remote } = opts
  const fail = (message: string): SyncResult => {
    io.log(`FAIL: ${message}`)
    return { ok: false, message }
  }

  const current = (await io.git('rev-parse', '--abbrev-ref', 'HEAD')).out.trim()
  if (current !== branch) return fail(`not on ${branch} (currently on ${current})`)

  if (!(await io.git('fetch', remote, branch)).ok) return fail('git fetch failed')

  const dirty = (await io.git('status', '--porcelain')).out.trim().length > 0
  if (dirty) {
    io.log('local drift detected, staging changes')
    await io.git('add', '-A')

    const staged = (await io.git('diff', '--cached', '--name-only')).out.split('\n').filter(Boolean)

    const suspicious = findSuspiciousPaths(staged)
    if (suspicious.length > 0) {
      await io.git('reset')
      return fail(`aborting: staged files look like secrets: ${suspicious.join(', ')}`)
    }

    const keyHits = staged.filter((p) => {
      const content = io.readFile(p)
      return content !== null && containsPrivateKey(content)
    })
    if (keyHits.length > 0) {
      await io.git('reset')
      return fail(`aborting: staged files contain private key material: ${keyHits.join(', ')}`)
    }

    const oversize = findOversize(staged.map((p) => ({ path: p, size: io.fileSize(p) })))
    if (oversize.length > 0) {
      await io.git('reset')
      return fail(
        `aborting: staged files exceed 95MB (GitHub limit is 100MB): ${oversize
          .map((e) => `${e.path} (${Math.round(e.size / 1024 / 1024)}MB)`)
          .join(', ')}`
      )
    }

    if (staged.length > 0) {
      if (!(await io.git('commit', '-m', `auto-sync: ${opts.date} (${opts.host})`)).ok) {
        return fail('git commit failed')
      }
      io.log('committed local drift')
    } else {
      io.log('no tracked changes after staging (likely only ignored files)')
    }
  }

  if (!(await io.git('pull', '--rebase', remote, branch)).ok) {
    await io.git('rebase', '--abort')
    return fail('git pull --rebase conflict, needs manual attention')
  }

  const attempts = opts.pushAttempts ?? 3
  let ahead = parseInt((await io.git('rev-list', '--count', `${remote}/${branch}..HEAD`)).out.trim(), 10) || 0
  if (ahead === 0) {
    io.log('nothing to push')
    return { ok: true, message: 'nothing to push' }
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if ((await io.git('push', remote, branch)).ok) {
      const message = `pushed ${ahead} commit(s) to ${remote}/${branch} (attempt ${attempt})`
      io.log(message)
      return { ok: true, message }
    }
    io.log(`push attempt ${attempt} failed, refetching and rebasing`)
    if (!(await io.git('pull', '--rebase', remote, branch)).ok) {
      await io.git('rebase', '--abort')
      return fail('rebase conflict during push retry, needs manual attention')
    }
    ahead = parseInt((await io.git('rev-list', '--count', `${remote}/${branch}..HEAD`)).out.trim(), 10) || 0
  }

  return fail(`git push failed after ${attempts} attempts`)
}
