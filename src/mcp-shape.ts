/**
 * The two `.mcp.json` shapes found in the wild.
 *
 *   nested — { "mcpServers": { name: {...} } }   Claude Code's format; what setup writes
 *   flat   — { name: {...} }                     hand-written configs, and this repo's older docs
 *
 * Every reader of the file has to accept both, or it silently sees an empty
 * config: the cockpit's declared-servers panel read only `mcpServers` and so
 * reported *no servers at all* for a flat file, while the ai-sdk runtime
 * loaded every server in that same file. Both readers now pick the server map
 * here so the two can't drift apart again.
 *
 * Shape detection only. Deciding which entries are usable is the caller's job:
 * the runtime keeps stdio servers (a `command` string), the cockpit also shows
 * url/type transports.
 */

/** Pick the server map out of parsed `.mcp.json` data. Null when there isn't one. */
export function selectMcpServerMap(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null
  const map = 'mcpServers' in data ? (data as { mcpServers: unknown }).mcpServers : data
  if (!map || typeof map !== 'object') return null
  return map as Record<string, unknown>
}

/**
 * True when the data uses the nested shape. Callers that read files which are
 * not exclusively MCP config (~/.claude.json, settings.json) need this: under
 * the flat fallback the whole file is the server map, so unrelated top-level
 * keys must be filtered out rather than listed as servers.
 */
export function isNestedMcpShape(data: unknown): boolean {
  return !!data && typeof data === 'object' && 'mcpServers' in data
}
