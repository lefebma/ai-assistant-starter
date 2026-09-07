import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import type { SyncIO } from '../sync/daily-sync.js'
import type { JoinIO } from './join.js'
import { parsePrivatePatterns } from './guards.js'

const execFileAsync = promisify(execFile)

export function keyPathFor(name: string): string {
  return resolve(homedir(), '.ssh', `havn-workspace-${name}`)
}

export function readPrivatePatterns(root: string = PROJECT_ROOT): string[] {
  try {
    return parsePrivatePatterns(readFileSync(resolve(root, 'workspaces', '.private-patterns'), 'utf-8'))
  } catch {
    return []
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
  return {
    keyExists: (keyPath) => existsSync(keyPath) && existsSync(`${keyPath}.pub`),
    generateKey: async (keyPath, comment) => {
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
      await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', keyPath])
    },
    readPublicKey: (keyPath) => readFileSync(`${keyPath}.pub`, 'utf-8'),
    sshConfigHas: (alias) => existsSync(sshConfig) && readFileSync(sshConfig, 'utf-8').includes(`Host ${alias}\n`),
    appendSshConfig: (block) => {
      mkdirSync(dirname(sshConfig), { recursive: true, mode: 0o700 })
      appendFileSync(sshConfig, block, { mode: 0o600 })
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
