import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'

export type McpServer = {
  name: string
  source: string         // which file declared it
  transport?: string     // "stdio" | "sse" | "http" | undefined
}

const SOURCES: { path: string; label: string }[] = [
  { path: resolve(homedir(), '.mcp.json'), label: '~/.mcp.json' },
  { path: resolve(homedir(), '.claude.json'), label: '~/.claude.json' },
  { path: resolve(PROJECT_ROOT, '.mcp.json'), label: 'project/.mcp.json' },
  { path: resolve(homedir(), '.claude/settings.json'), label: 'user/settings.json' },
]

function readJson(path: string): any | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function detectTransport(entry: any): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  if (entry.url) return 'http'
  if (entry.command) return 'stdio'
  if (entry.type) return String(entry.type)
  return undefined
}

export function getDeclaredMcpServers(): McpServer[] {
  const seen = new Map<string, McpServer>()
  for (const src of SOURCES) {
    const data = readJson(src.path)
    if (!data) continue
    const servers = data.mcpServers
    if (!servers || typeof servers !== 'object') continue
    for (const [name, entry] of Object.entries(servers)) {
      if (seen.has(name)) continue // first source wins
      seen.set(name, { name, source: src.label, transport: detectTransport(entry) })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
