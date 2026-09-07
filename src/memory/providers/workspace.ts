import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { PROJECT_ROOT } from '../../env.js'
import { STORE_DIR } from '../../config.js'
import { loadRegistry, workspaceDir } from '../../workspace/registry.js'
import type { WorkspaceEntry } from '../../workspace/types.js'
import type { ContextProvider, ContextFragment } from './base.js'

/**
 * Surfaces shared-workspace content under a banner that names who else can
 * see it, plus standing rules. The banner is the feature: without it the
 * model cannot tell a shared file from a private one.
 */

const GATING_REGEX =
  /\b(project|build|code|deploy|bug|feature|sprint|admin|backlog|marketing|campaign|status|update|blocker|plan|workspace|shared|launch|draft|decision|meeting)\b/i
const SUMMARY_CHARS = 500
const MAX_STATES_ON_HINT = 3

export const RULES = [
  'SHARED WORKSPACE RULES:',
  '- Never copy content from projects/, brain/, memory, email, or any private source into a workspace file unless the human asked for that specific content to be shared.',
  '- Write only to the workspace whose members the request concerns. If a message spans two workspaces, ask which one.',
  '- Mark drafts with "status: draft" in frontmatter. Your commits are prefixed with your own name automatically.',
  '- When unsure whether something is shareable, ask.',
].join('\n')

export function bannerFor(entry: WorkspaceEntry): string {
  const m = entry.manifest
  const shared = m?.sharedWith ?? 'unknown'
  const members = (m?.members ?? []).map((x) => (x.assistant ? `${x.human} + ${x.assistant}` : x.human)).join(', ') || '(members not listed)'
  const base = `SHARED WORKSPACE "${entry.name}" (${shared}). Members: ${members}. Anything written here is visible to all members. Files live under workspaces/${entry.name}/.`
  return shared === 'unknown' ? `${base} No WORKSPACE.md manifest. Do not write anything to this workspace until one exists.` : base
}

function walkStates(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkStates(full, out)
    else if (e.isFile() && e.name === 'STATE.md') out.push(full)
  }
  return out
}

function firstNames(entry: WorkspaceEntry): string[] {
  const out = new Set<string>([entry.name.toLowerCase()])
  for (const m of entry.manifest?.members ?? []) {
    for (const n of [m.human, m.assistant]) {
      const first = n.trim().split(/\s+/)[0]?.toLowerCase()
      if (first && first.length > 2) out.add(first)
    }
  }
  return [...out]
}

export class WorkspaceProvider implements ContextProvider {
  name = 'workspace'
  priority = 45
  enabled = true
  private storeDir: string
  private root: string

  constructor(opts: { storeDir?: string; root?: string } = {}) {
    this.storeDir = opts.storeDir ?? STORE_DIR
    this.root = opts.root ?? PROJECT_ROOT
  }

  async retrieve(chatId: string, message: string): Promise<ContextFragment[]> {
    const entries = loadRegistry(this.storeDir).filter((e) => e.enabled)
    if (entries.length === 0) return []
    const lower = message.toLowerCase()
    const gated = GATING_REGEX.test(message)
    const frags: ContextFragment[] = []

    for (const entry of entries) {
      const chatHint = entry.chatIds.includes(String(chatId))
      const nameHit = firstNames(entry).some((n) => new RegExp(`\\b${n}\\b`).test(lower))
      if (!chatHint && !nameHit && !gated) continue

      const dir = workspaceDir(entry, this.root)
      const states = walkStates(dir)
      const matched = states.filter((s) => {
        const parts = relative(dir, dirname(s)).split('/').filter(Boolean).map((p) => p.toLowerCase())
        return parts.some((p) => lower.includes(p))
      })
      let chosen = matched
      if (chosen.length === 0 && (chatHint || nameHit)) chosen = states.slice(0, MAX_STATES_ON_HINT)
      if (chosen.length === 0 && !chatHint && !nameHit) continue

      frags.push({ source: this.name, content: bannerFor(entry), relevance: 0.9 })
      for (const s of chosen) {
        try {
          const raw = readFileSync(s, 'utf-8').slice(0, SUMMARY_CHARS)
          frags.push({ source: this.name, content: `[${entry.name}/${relative(dir, s)}] ${raw}`, relevance: 0.7 })
        } catch {
          // unreadable state file, skip
        }
      }
    }

    if (frags.length > 0) frags.push({ source: this.name, content: RULES, relevance: 0.9 })
    return frags
  }
}
