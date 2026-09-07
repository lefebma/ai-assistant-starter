import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import type { SyncIO } from '../sync/daily-sync.js'
import { ensureIncludeLine } from './join.js'
import type { JoinIO } from './join.js'
import { parsePrivatePatterns } from './guards.js'

const execFileAsync = promisify(execFile)

export function keyPathFor(name: string): string {
  return resolve(homedir(), '.ssh', `havn-workspace-${name}`)
}

export function privatePatternsPath(root: string = PROJECT_ROOT): string {
  return resolve(root, 'workspaces', '.private-patterns')
}

/**
 * The private-pattern guard is the only content-level guard the owner
 * controls, and an empty pattern list turns it into a no-op. Absent and empty
 * are therefore different answers: `present` is false only when the file is
 * missing, so the caller can say so out loud instead of syncing on with the
 * guard quietly switched off.
 */
export function readPrivatePatterns(root: string = PROJECT_ROOT): { patterns: string[]; present: boolean } {
  const p = privatePatternsPath(root)
  if (!existsSync(p)) return { patterns: [], present: false }
  try {
    return { patterns: parsePrivatePatterns(readFileSync(p, 'utf-8')), present: true }
  } catch {
    return { patterns: [], present: false }
  }
}

export function makeSyncIO(dir: string, log: (line: string) => void): SyncIO {
  return {
    git: async (...args) => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd: dir })
        return { ok: true, out: stdout }
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string }
        return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? String(err)}` }
      }
    },
    readFile: (path) => {
      try {
        const buf = readFileSync(resolve(dir, path))
        // Binary sniff: a NUL byte in the first 8KB means not text.
        return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf-8')
      } catch {
        return null
      }
    },
    rebaseInProgress: () =>
      existsSync(resolve(dir, '.git', 'rebase-merge')) || existsSync(resolve(dir, '.git', 'rebase-apply')),
    fileSize: (path) => {
      try {
        return statSync(resolve(dir, path)).size
      } catch {
        return 0
      }
    },
    log,
  }
}

export function makeJoinIO(): JoinIO {
  const sshConfig = resolve(homedir(), '.ssh', 'config')
  // Our Host blocks live in their own file so they can be Included ahead of
  // whatever the owner already has in ~/.ssh/config.
  const wsConfig = resolve(homedir(), '.ssh', 'havn-workspaces.conf')
  const includeLine = 'Include ~/.ssh/havn-workspaces.conf'
  return {
    keyExists: (keyPath) => existsSync(keyPath) && existsSync(`${keyPath}.pub`),
    generateKey: async (keyPath, comment) => {
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath])
    },
    readPublicKey: (keyPath) => readFileSync(`${keyPath}.pub`, 'utf-8'),
    sshConfigHas: (alias) => existsSync(wsConfig) && readFileSync(wsConfig, 'utf-8').includes(`Host ${alias}\n`),
    appendSshConfig: (block) => {
      mkdirSync(dirname(wsConfig), { recursive: true, mode: 0o700 })
      appendFileSync(wsConfig, block, { mode: 0o600 })
      chmodSync(wsConfig, 0o600)
      const existing = existsSync(sshConfig) ? readFileSync(sshConfig, 'utf-8') : ''
      const next = ensureIncludeLine(existing, includeLine)
      if (next !== existing) writeFileSync(sshConfig, next, { mode: 0o600 })
    },
    gitLsRemote: async (url) => {
      try {
        await execFileAsync('git', ['ls-remote', '--exit-code', url, 'HEAD'], { timeout: 30_000 })
        return true
      } catch {
        return false
      }
    },
    gitClone: async (url, dir) => {
      try {
        mkdirSync(dirname(dir), { recursive: true })
        const { stdout } = await execFileAsync('git', ['clone', url, dir], { timeout: 120_000 })
        return { ok: true, out: stdout }
      } catch (err) {
        const e = err as { stderr?: string }
        return { ok: false, out: e.stderr ?? String(err) }
      }
    },
    gitConfig: async (dir, key, value) => {
      await execFileAsync('git', ['config', key, value], { cwd: dir })
    },
    readManifest: (dir) => {
      try {
        return readFileSync(resolve(dir, 'WORKSPACE.md'), 'utf-8')
      } catch {
        return null
      }
    },
    dirExists: (dir) => existsSync(resolve(dir, '.git')),
  }
}
