import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContextProvider, ContextFragment } from './base.js'

/**
 * Project provider - discovers STATE.md files under projects/ and injects
 * relevant project context based on message keywords.
 *
 * Replaces the old hardcoded PROJECTS array. Drop a STATE.md anywhere under
 * projects/ and it auto-wires on the next discovery pass.
 */

interface DiscoveredProject {
  id: string
  name: string
  statePath: string
  triggers: string[]
}

interface CacheEntry {
  content: string
  mtimeMs: number
  fetchedAt: number
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const PROJECTS_DIR = join(PROJECT_ROOT, 'projects')
const DISCOVERY_TTL = 300_000 // 5 min
const SUMMARY_CHARS = 500

// Generic gating regex - triggers project context injection.
// Users should add their own project-specific keywords.
const GATING_REGEX =
  /\b(project|build|code|deploy|bug|feature|sprint|admin|backlog|marketing|campaign|status|update|blocker)\b/i

let projectsCache: DiscoveredProject[] | null = null
let projectsCacheAt = 0

function walkStateFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkStateFiles(full, out)
    } else if (entry.isFile() && entry.name === 'STATE.md') {
      out.push(full)
    }
  }
  return out
}

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const match = raw.match(/^---\n([\s\S]+?)\n---/)
  if (!match) return {}
  const result: Record<string, string | string[]> = {}
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      continue
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function deriveTriggers(statePath: string, frontmatter: Record<string, string | string[]>): string[] {
  const fmTriggers = frontmatter.triggers
  if (Array.isArray(fmTriggers) && fmTriggers.length > 0) {
    return fmTriggers.map((t) => t.toLowerCase())
  }
  const rel = relative(PROJECTS_DIR, dirname(statePath))
  const parts = rel.split('/').filter(Boolean)
  return Array.from(new Set(parts.map((p) => p.toLowerCase())))
}

function discoverProjects(): DiscoveredProject[] {
  const paths = walkStateFiles(PROJECTS_DIR)
  const projects: DiscoveredProject[] = []
  for (const statePath of paths) {
    let raw: string
    try {
      raw = readFileSync(statePath, 'utf-8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(raw)
    const id = typeof fm.id === 'string' ? fm.id : relative(PROJECTS_DIR, dirname(statePath)).replace(/\//g, '-')
    const name = typeof fm.name === 'string' ? fm.name : id
    const triggers = deriveTriggers(statePath, fm)
    projects.push({ id, name, statePath, triggers })
  }
  return projects
}

export function reloadProjects(): DiscoveredProject[] {
  projectsCache = discoverProjects()
  projectsCacheAt = Date.now()
  return projectsCache
}

function getProjects(): DiscoveredProject[] {
  const now = Date.now()
  if (!projectsCache || now - projectsCacheAt > DISCOVERY_TTL) {
    return reloadProjects()
  }
  return projectsCache
}

export class ProjectProvider implements ContextProvider {
  name = 'project'
  priority = 40
  enabled = true

  private cache: Map<string, CacheEntry> = new Map()
  private cacheTtl = DISCOVERY_TTL

  async retrieve(_chatId: string, message: string): Promise<ContextFragment[]> {
    if (!GATING_REGEX.test(message)) return []

    const lower = message.toLowerCase()
    const projects = getProjects()
    const fragments: ContextFragment[] = []

    for (const project of projects) {
      const hit = project.triggers.some((t) => lower.includes(t))
      if (!hit) continue

      let content: string | null = null
      const cached = this.cache.get(project.statePath)
      const now = Date.now()

      let currentMtime = 0
      try {
        currentMtime = statSync(project.statePath).mtimeMs
      } catch {
        continue
      }

      if (cached && now - cached.fetchedAt < this.cacheTtl && cached.mtimeMs === currentMtime) {
        content = cached.content
      } else {
        try {
          const raw = readFileSync(project.statePath, 'utf-8')
          content = raw.slice(0, SUMMARY_CHARS)
          this.cache.set(project.statePath, { content, mtimeMs: currentMtime, fetchedAt: now })
        } catch {
          continue
        }
      }

      if (content) {
        fragments.push({
          source: this.name,
          content: `[${project.name} status] ${content}`,
          relevance: 0.6,
        })
      }
    }

    return fragments
  }
}
