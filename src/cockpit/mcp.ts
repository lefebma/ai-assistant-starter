import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { isNestedMcpShape, selectMcpServerMap } from '../mcp-shape.js'

export type McpServer = {
  name: string
  source: string         // which file declared it
  transport?: string     // "stdio" | "sse" | "http" | undefined
}

export type McpConfigSource = { path: string; label: string }

const SOURCES: McpConfigSource[] = [
  { path: resolve(homedir(), '.mcp.json'), label: '~/.mcp.json' },
  { path: resolve(homedir(), '.claude.json'), label: '~/.claude.json' },
  { path: resolve(PROJECT_ROOT, '.mcp.json'), label: 'project/.mcp.json' },
  { path: resolve(homedir(), '.claude/settings.json'), label: 'user/settings.json' },
]

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  return parsed as Record<string, unknown>
}

function detectTransport(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as { url?: unknown; command?: unknown; type?: unknown }
  if (e.url) return 'http'
  if (e.command) return 'stdio'
  if (e.type) return String(e.type)
  return undefined
}

/**
 * Collect declared servers from an explicit source list. Earlier sources win
 * a name collision. Exported for tests; production callers want
 * getDeclaredMcpServers().
 */
export function collectDeclaredServers(sources: readonly McpConfigSource[]): McpServer[] {
  const seen = new Map<string, McpServer>()
  for (const src of sources) {
    const data = readJson(src.path)
    if (!data) continue
    const servers = selectMcpServerMap(data)
    if (!servers) continue
    const nested = isNestedMcpShape(data)
    for (const [name, entry] of Object.entries(servers)) {
      const transport = detectTransport(entry)
      // Under the flat fallback the file's top level *is* the server map, and
      // two of the sources above are not MCP-only files -- without this their
      // permissions/hooks/env keys would be listed as servers. Entries in an
      // explicit mcpServers block are taken at their word.
      if (!nested && !transport) continue
      if (seen.has(name)) continue // first source wins
      seen.set(name, { name, source: src.label, transport })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getDeclaredMcpServers(): McpServer[] {
  return collectDeclaredServers(SOURCES)
}
