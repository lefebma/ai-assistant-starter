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

const HOST_RE = /^[A-Za-z0-9.-]+$/
const PATH_RE = /^[A-Za-z0-9._\-/]+$/
export const REPO_URL_HELP = 'SSH URLs only, for example git@github.com:org/repo.git'

/**
 * The repo URL becomes a HostName in ~/.ssh/config, the file that governs
 * every SSH authentication on this box, and an argv element for git. So it is
 * an allowlist, not a sniff: scp-style or ssh://, a host of letters, digits,
 * dots and dashes, a path of letters, digits, dots, dashes, underscores and
 * slashes with no .. segment, no leading dash (which git would read as a flag),
 * and no whitespace or control character (a newline would inject ssh config
 * directives).
 */
export function validateRepoUrl(repo: string): { ok: true; host: string } | { ok: false; reason: string } {
  const no = { ok: false as const, reason: REPO_URL_HELP }
  if (typeof repo !== 'string' || repo.length === 0 || repo.length > 512) return no
  if (repo.startsWith('-')) return no
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(repo)) return no

  const scp = repo.match(/^git@([^:]+):(.+)$/)
  const ssh = repo.match(/^ssh:\/\/git@([^/]+)\/(.+)$/)
  const m = scp ?? ssh
  if (!m) return no
  const [, host, path] = m
  if (!HOST_RE.test(host) || host.startsWith('-') || host.startsWith('.')) return no
  if (!PATH_RE.test(path) || path.startsWith('-') || path.includes('//')) return no
  if (path.split('/').some((seg) => seg === '..')) return no
  return { ok: true, host }
}

/** Host of a validated scp-style or ssh:// git url. */
function hostOf(repo: string): string {
  const v = validateRepoUrl(repo)
  return v.ok ? v.host : 'github.com'
}

export function rewriteRepoUrl(repo: string, alias: string): string {
  const host = hostOf(repo)
  return repo.replace(host, alias)
}

/**
 * IdentityFile is cumulative: keys contributed by an earlier `Host *` stanza
 * (the usual macOS one) accumulate, and IdentitiesOnly does not discard them,
 * so the clone could authenticate with the owner's personal key rather than
 * the scoped deploy key. This block therefore lives in its own file that an
 * Include at the very top of ~/.ssh/config pulls in first, and IdentityAgent
 * none stops a loaded agent key being offered either.
 */
export function sshConfigBlock(alias: string, keyPath: string, host = 'github.com'): string {
  return [
    '',
    `# havn workspace: ${alias}`,
    `Host ${alias}`,
    `  HostName ${host}`,
    '  User git',
    `  IdentityFile ${keyPath}`,
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    '',
  ].join('\n')
}

/**
 * Pure: return `existing` with `includeLine` as its first line, or unchanged
 * if that line is already somewhere in the file. Never duplicates it.
 */
export function ensureIncludeLine(existing: string, includeLine: string): string {
  const wanted = includeLine.trim()
  if (existing.split('\n').some((l) => l.trim() === wanted)) return existing
  if (existing.trim() === '') return `${wanted}\n`
  return `${wanted}\n\n${existing}`
}

/**
 * Two-pass join. Pass one ends at "key-ready" so the owner can add the deploy
 * key; pass two (same command) tests access, clones, and reads the manifest.
 * Idempotent: every step checks before it acts.
 */
export async function runJoin(io: JoinIO, opts: JoinOptions): Promise<JoinOutcome> {
  // Defence in depth: commands.ts rejects a bad URL before we get here, but
  // this function writes to ~/.ssh and builds git argv, so it checks too.
  const valid = validateRepoUrl(opts.repo)
  if (!valid.ok) return { stage: 'clone-failed', message: valid.reason }
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
