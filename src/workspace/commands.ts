import { rmSync } from 'node:fs'
import { PROJECT_ROOT } from '../env.js'
import { runJoin, validateRepoUrl } from './join.js'
import type { JoinIO } from './join.js'
import { keyPathFor, readPrivatePatterns } from './io.js'
import { identity as readIdentity, loadRegistry, removeWorkspace, upsertWorkspace, workspaceDir, getWorkspace } from './registry.js'
import { defaultSyncOne, syncNow } from './service.js'
import type { Notify } from './service.js'
import type { WorkspaceSyncResult } from './sync.js'
import type { WorkspaceEntry } from './types.js'

export interface CommandDeps {
  joinIO: JoinIO
  storeDir?: string
  root?: string
  identity?: { owner: string; assistant: string }
  syncOne?: (e: WorkspaceEntry) => Promise<WorkspaceSyncResult>
  notify?: Notify
  removeDir?: (dir: string) => void
  /** Put a freshly joined workspace on its sync timer without a restart. */
  schedule?: (entry: WorkspaceEntry) => void
  /** Take a left workspace off its timer. */
  unschedule?: (name: string) => void
}

const USAGE = [
  'Usage: /workspace join <name> <ssh-url>',
  '       /workspace status',
  '       /workspace sync [name]',
  '       /workspace leave <name>',
].join('\n')

const NAME_RE = /^[a-z0-9-]{1,32}$/

function fmtMembers(entry: WorkspaceEntry): string {
  const m = entry.manifest?.members ?? []
  if (m.length === 0) return '(no members listed)'
  return m.map((x) => (x.assistant ? `${x.human} + ${x.assistant}` : x.human) + ` (${x.role})`).join(', ')
}

function ago(ts?: number): string {
  if (!ts) return 'never'
  const mins = Math.round((Date.now() - ts) / 60_000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
}

export async function workspaceCommand(args: string[], deps: CommandDeps): Promise<string> {
  const [sub, a1, a2] = args
  const root = deps.root ?? PROJECT_ROOT
  const syncOne = deps.syncOne ?? defaultSyncOne
  const notify = deps.notify ?? (async () => {})

  if (sub === 'join') {
    if (!a1 || !a2) return USAGE
    if (!NAME_RE.test(a1)) return 'Workspace name must be lowercase letters, digits, or dashes (max 32).'
    const url = validateRepoUrl(a2)
    if (!url.ok) return url.reason
    const id = deps.identity ?? readIdentity(root)
    const entry: WorkspaceEntry = getWorkspace(a1, deps.storeDir) ?? {
      name: a1, repo: a2, path: '', syncMinutes: 30, enabled: true, chatIds: [], failures: 0,
    }
    const dir = workspaceDir(entry, root)
    const outcome = await runJoin(deps.joinIO, { name: a1, repo: a2, dir, keyPath: keyPathFor(a1), owner: id.owner, assistant: id.assistant })

    switch (outcome.stage) {
      case 'key-ready':
        return [
          `Key ready for "${a1}". Add it to the repo as a deploy key with write access:`,
          'GitHub: repo Settings, Deploy keys, Add deploy key, tick "Allow write access".',
          '',
          '```',
          outcome.publicKey,
          '```',
          '',
          `Then run the same join command again.`,
        ].join('\n')
      case 'access-denied':
        return [
          `The repo refused this key. Check the deploy key on ${a2} has write access, then run join again.`,
          '',
          '```',
          outcome.publicKey,
          '```',
        ].join('\n')
      case 'clone-failed':
        return `Clone failed: ${outcome.message}`
      case 'joined': {
        entry.repo = a2
        entry.manifest = outcome.manifest
        upsertWorkspace(entry, deps.storeDir)
        const first = await syncNow(a1, { syncOne, notify, storeDir: deps.storeDir })
        deps.schedule?.(entry)
        const lines = [
          `Joined "${a1}" (${outcome.manifest.sharedWith}). Members: ${fmtMembers(entry)}.`,
          `Files under workspaces/${a1}/. First sync: ${first.message}.`,
        ]
        if (outcome.warning) lines.push(outcome.warning)
        return lines.join('\n')
      }
    }
  }

  if (sub === 'status' || sub === undefined) {
    const entries = loadRegistry(deps.storeDir)
    if (entries.length === 0) return 'No workspaces joined. ' + USAGE
    const { patterns, present } = readPrivatePatterns(root)
    const patternLine = present
      ? `private patterns: ${patterns.length}`
      : 'private patterns: none (workspaces/.private-patterns missing)'
    return entries
      .map((e) => [
        `${e.name} (${e.manifest?.sharedWith ?? 'unknown'}${e.enabled ? '' : ', disabled'})`,
        `  members: ${fmtMembers(e)}`,
        `  last sync: ${ago(e.lastSyncAt)}${e.lastSyncOk === false ? ` FAILED: ${e.lastSyncMessage ?? ''}` : ''}`,
      ].join('\n'))
      .concat(patternLine)
      .join('\n')
  }

  if (sub === 'sync') {
    const names = a1 ? [a1] : loadRegistry(deps.storeDir).map((e) => e.name)
    if (names.length === 0) return 'No workspaces joined.'
    const out: string[] = []
    for (const n of names) {
      const r = await syncNow(n, { syncOne, notify, storeDir: deps.storeDir })
      out.push(`${n}: ${r.message}`)
    }
    return out.join('\n')
  }

  if (sub === 'leave') {
    if (!a1) return USAGE
    const entry = getWorkspace(a1, deps.storeDir)
    if (!entry) return `No workspace named "${a1}".`
    const dir = workspaceDir(entry, root)
    ;(deps.removeDir ?? ((d) => rmSync(d, { recursive: true, force: true })))(dir)
    deps.unschedule?.(a1)
    removeWorkspace(a1, deps.storeDir)
    return `Left "${a1}". Removed ${dir} and the sync schedule. The SSH key ${keyPathFor(a1)} was left in place; delete it by hand if you will not rejoin.`
  }

  return USAGE
}

/** "/workspace join a b" -> ["join","a","b"]; tolerates the @BotName suffix. */
export function workspaceCommandArgs(text: string): string[] {
  return text.trim().replace(/^\/workspace(@\S+)?\s*/i, '').split(/\s+/).filter(Boolean)
}
