import { parseWorkspaceManifest } from './manifest.js'
import type { WorkspaceManifest } from './types.js'

export interface JoinIO {
  keyExists(keyPath: string): boolean
  generateKey(keyPath: string, comment: string): Promise<void>
  readPublicKey(keyPath: string): string
  sshConfigHas(alias: string): boolean
  appendSshConfig(block: string): void
  gitLsRemote(url: string): Promise<boolean>
  gitClone(url: string, dir: string): Promise<{ ok: boolean; out: string }>
  gitConfig(dir: string, key: string, value: string): Promise<void>
  readManifest(dir: string): string | null
  dirExists(dir: string): boolean
}

export interface JoinOptions {
  name: string
  repo: string
  dir: string
  keyPath: string
  owner: string
  assistant: string
}

export type JoinOutcome =
  | { stage: 'key-ready'; publicKey: string; created: boolean }
  | { stage: 'access-denied'; publicKey: string }
  | { stage: 'clone-failed'; message: string }
  | { stage: 'joined'; manifest: WorkspaceManifest; warning?: string }

export function sshAlias(name: string): string {
  return `havn-ws-${name}`
}

/** Extract the host of an scp-style or ssh:// git url. */
function hostOf(repo: string): string {
  const ssh = repo.match(/^ssh:\/\/[^@]+@([^/]+)\//)
  if (ssh) return ssh[1]
  const scp = repo.match(/^[^@]+@([^:]+):/)
  return scp ? scp[1] : 'github.com'
}

export function rewriteRepoUrl(repo: string, alias: string): string {
  const host = hostOf(repo)
  return repo.replace(host, alias)
}

export function sshConfigBlock(alias: string, keyPath: string, host = 'github.com'): string {
  return [
    '',
    `# havn workspace: ${alias}`,
    `Host ${alias}`,
    `  HostName ${host}`,
    '  User git',
    `  IdentityFile ${keyPath}`,
    '  IdentitiesOnly yes',
    '',
  ].join('\n')
}

/**
 * Two-pass join. Pass one ends at "key-ready" so the owner can add the deploy
 * key; pass two (same command) tests access, clones, and reads the manifest.
 * Idempotent: every step checks before it acts.
 */
export async function runJoin(io: JoinIO, opts: JoinOptions): Promise<JoinOutcome> {
  const alias = sshAlias(opts.name)
  let created = false
  if (!io.keyExists(opts.keyPath)) {
    await io.generateKey(opts.keyPath, `${opts.assistant.toLowerCase()}@havn-workspace-${opts.name}`)
    created = true
  }
  if (!io.sshConfigHas(alias)) io.appendSshConfig(sshConfigBlock(alias, opts.keyPath, hostOf(opts.repo)))
  const publicKey = io.readPublicKey(opts.keyPath).trim()

  const url = rewriteRepoUrl(opts.repo, alias)
  if (created) return { stage: 'key-ready', publicKey, created }
  if (!(await io.gitLsRemote(url))) return { stage: 'access-denied', publicKey }

  if (!io.dirExists(opts.dir)) {
    const clone = await io.gitClone(url, opts.dir)
    if (!clone.ok) return { stage: 'clone-failed', message: clone.out.trim() }
  }
  await io.gitConfig(opts.dir, 'user.name', `${opts.assistant} (${opts.owner})`)
  await io.gitConfig(opts.dir, 'user.email', `${opts.assistant.toLowerCase()}@havn.noreply`)

  const raw = io.readManifest(opts.dir)
  const manifest = parseWorkspaceManifest(raw ?? '', opts.name)
  const warning = raw === null ? 'No WORKSPACE.md in this repo. Treated as shared-with: unknown, strictest rules apply until one exists.' : undefined
  return { stage: 'joined', manifest, warning }
}
