/**
 * Registers the bundled Playwright MCP server in .mcp.json.
 *
 * The launcher (scripts/playwright-mcp.ts) and the /browser command have both
 * shipped since browser automation was first advertised in CLAUDE.md, but
 * nothing ever wrote the .mcp.json entry that hands the tools to the agent. A
 * fresh install could therefore open a debuggable Chrome and had no way to
 * drive it. Setup writes the entry now.
 *
 * Merging, not overwriting: an install that already lists other servers keeps
 * them, and re-running setup is a no-op once the entry is present. Both shapes
 * the runtime accepts are preserved (see parseMcpConfig in runtime/ai-sdk).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PLAYWRIGHT_SERVER_NAME = 'playwright'

export interface McpServerEntry {
  command: string
  args: string[]
}

/**
 * Absolute on both halves, deliberately.
 *
 * The command: bundle installs carry their own Node and may have no `node` on
 * PATH at all, so a bare "node" is not safe to write.
 *
 * The script: neither runtime pins a cwd for the MCP child. The AI SDK's stdio
 * transport passes no cwd, so the server inherits the service process's; the
 * claude runtime spawns under a per-session workspace when one is set. A
 * relative "dist/scripts/..." would resolve against whichever of those the
 * child happened to get. The cost is that moving the install folder breaks the
 * entry, which re-running setup repairs, and which is already true of the
 * launchd/winsw service files.
 */
export function playwrightServerEntry(projectRoot: string, nodeBin: string): McpServerEntry {
  return {
    command: nodeBin,
    args: [resolve(projectRoot, 'dist', 'scripts', 'playwright-mcp.js')],
  }
}

export type McpMergeOutcome = 'created' | 'added' | 'present' | 'unparsable'

export interface McpMergeResult {
  /** File content to write, or null when the file should be left alone. */
  content: string | null
  outcome: McpMergeOutcome
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const serialize = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`

/**
 * @param existing current .mcp.json contents, or null when the file is absent.
 */
export function mergePlaywrightServer(existing: string | null, entry: McpServerEntry): McpMergeResult {
  if (existing === null || existing.trim() === '') {
    return { content: serialize({ mcpServers: { [PLAYWRIGHT_SERVER_NAME]: entry } }), outcome: 'created' }
  }

  let data: unknown
  try {
    data = JSON.parse(existing)
  } catch {
    return { content: null, outcome: 'unparsable' }
  }
  if (!isPlainObject(data)) return { content: null, outcome: 'unparsable' }

  // Keep whichever shape the owner's file already uses rather than rewriting
  // it: both are valid, and a silent reshape is a confusing diff to receive.
  const nested = isPlainObject(data.mcpServers)
  const servers = nested ? (data.mcpServers as Record<string, unknown>) : data
  if (PLAYWRIGHT_SERVER_NAME in servers) return { content: null, outcome: 'present' }

  const merged = { ...servers, [PLAYWRIGHT_SERVER_NAME]: entry }
  return {
    content: serialize(nested ? { ...data, mcpServers: merged } : merged),
    outcome: 'added',
  }
}

/**
 * Read/merge/write .mcp.json at an install root. Idempotent.
 *
 * Called from setup and from both update paths. The update call is what
 * reaches installs that predate browser automation working: .mcp.json is in
 * neither PRESERVED_PATHS nor BUNDLE_PAYLOAD_PATHS, so an update never touches
 * it, and without this those installs would stay toolless until their owner
 * happened to re-run setup. Merging here rather than shipping a default in the
 * payload is deliberate: the payload path is a blind replace, which would
 * overwrite a hand-edited entry on every future update.
 */
export function ensurePlaywrightMcp(projectRoot: string, nodeBin: string): McpMergeResult {
  const path = resolve(projectRoot, '.mcp.json')
  const result = mergePlaywrightServer(
    existsSync(path) ? readFileSync(path, 'utf-8') : null,
    playwrightServerEntry(projectRoot, nodeBin)
  )
  if (result.content) writeFileSync(path, result.content)
  return result
}
