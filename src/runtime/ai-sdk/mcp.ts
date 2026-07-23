/**
 * MCP tool loading for the AI SDK runtime.
 *
 * Reads .mcp.json at the project root (supports both the flat map this repo
 * uses and Claude Code's { "mcpServers": {...} } shape), connects to each
 * local stdio server, and exposes their tools named Claude Code-style
 * (mcp__<server>__<tool>) so prompts and skills written against the claude
 * runtime keep working. Servers that fail to connect are skipped with a
 * warning — a broken MCP server must never take down the agent.
 *
 * Clients stay open for the service lifetime (long-running app pattern).
 * Set AI_MCP=off to skip MCP entirely (used by the eval harness).
 *
 * Not covered here: claude.ai-hosted OAuth connectors. Those authenticate
 * through Claude Code itself and are claude-runtime-only until the BYOK
 * product layer (Phase 4) gives them a home.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { ToolSet } from 'ai'
import { readEnvFile } from '../../env.js'
import { logger } from '../../logger.js'

const CONNECT_TIMEOUT_MS = 10_000

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** Parse .mcp.json content. Accepts flat { name: {command,...} } or { mcpServers: {...} }. */
export function parseMcpConfig(json: string): Record<string, McpServerConfig> {
  const data = JSON.parse(json) as Record<string, unknown>
  const servers =
    data && typeof data === 'object' && 'mcpServers' in data
      ? (data.mcpServers as Record<string, unknown>)
      : data
  const result: Record<string, McpServerConfig> = {}
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (cfg && typeof cfg === 'object' && typeof (cfg as McpServerConfig).command === 'string') {
      result[name] = cfg as McpServerConfig
    }
  }
  return result
}

function mcpEnabled(): boolean {
  const flag = readEnvFile().AI_MCP?.trim() || process.env.AI_MCP?.trim()
  return flag !== 'off'
}

/**
 * Race a promise against a deadline. On timeout the loser is NOT cancelled:
 * a hung stdio server's child process may linger. Bounded to at most one
 * orphan per configured server per service start, since loadMcpTools runs
 * once per runtime instance (memoized by the caller).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

export async function loadMcpTools(projectRoot: string): Promise<ToolSet> {
  if (!mcpEnabled()) {
    logger.info('MCP disabled (AI_MCP=off)')
    return {}
  }

  let raw: string
  try {
    raw = readFileSync(resolve(projectRoot, '.mcp.json'), 'utf-8')
  } catch {
    return {} // no .mcp.json is a normal setup
  }

  let servers: Record<string, McpServerConfig>
  try {
    servers = parseMcpConfig(raw)
  } catch (err) {
    logger.warn({ err }, 'Could not parse .mcp.json; continuing without MCP tools')
    return {}
  }

  const tools: ToolSet = {}
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const client = await withTimeout(
        createMCPClient({
          transport: new Experimental_StdioMCPTransport({
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
          }),
        }),
        CONNECT_TIMEOUT_MS,
        `MCP server '${name}' connect`
      )
      const serverTools = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `MCP server '${name}' tools()`)
      for (const [toolName, t] of Object.entries(serverTools)) {
        tools[`mcp__${name}__${toolName}`] = t
      }
      logger.info({ server: name, toolCount: Object.keys(serverTools).length }, 'MCP server connected')
    } catch (err) {
      logger.warn({ err: String(err), server: name }, 'MCP server unavailable; continuing without it')
    }
  }
  return tools
}
