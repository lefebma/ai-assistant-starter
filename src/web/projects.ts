/**
 * Project discovery for the web UI: projects/**\/STATE.md with simple
 * `key: value` frontmatter. Separate from ProjectProvider's private parser on
 * purpose, so the two can change independently.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export interface ProjectInfo {
  id: string
  name: string
  company: string
  status: string
  /** STATE.md path relative to the root, with forward slashes. */
  statePath: string
}

const MAX_DEPTH = 4

function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/)
  const out: Record<string, string> = {}
  if (lines[0]?.trim() !== '---') return out
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') break
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1)
    }
    out[m[1]!.toLowerCase()] = v
  }
  return out
}

export function listProjects(root: string = PROJECT_ROOT): ProjectInfo[] {
  const base = join(root, 'projects')
  const found: ProjectInfo[] = []

  const walk = (rel: string[], depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(join(base, ...rel), { withFileTypes: true })
    } catch {
      return
    }
    // A STATE.md directly in projects/ has no project directory to name it.
    if (rel.length > 0 && entries.some((e) => e.name === 'STATE.md' && e.isFile())) {
      let fm: Record<string, string> = {}
      try {
        fm = parseFrontmatter(readFileSync(join(base, ...rel, 'STATE.md'), 'utf-8'))
      } catch {
        /* unreadable: still list it with defaults */
      }
      found.push({
        id: fm['id'] || rel.join('-'),
        name: fm['name'] || fm['project'] || rel[rel.length - 1]!,
        company: fm['company'] || (rel.length > 1 ? rel[0]! : ''),
        status: fm['status'] || '',
        statePath: posix.join('projects', ...rel, 'STATE.md'),
      })
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      walk([...rel, e.name], depth + 1)
    }
  }
  walk([], 0)

  return found.sort(
    (a, b) => a.company.localeCompare(b.company, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** One line telling the assistant which project a chat is about. '' for General or an unknown id. */
export function projectFraming(projectId: string, root: string = PROJECT_ROOT): string {
  if (!projectId) return ''
  const p = listProjects(root).find((x) => x.id === projectId)
  if (!p) return ''
  const clean = (s: string) => s.replace(/[<>"\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
  return `This chat is about the project "${clean(p.name)}". Its state file is ${clean(p.statePath)}; read it for context and keep it updated when things change.`
}
