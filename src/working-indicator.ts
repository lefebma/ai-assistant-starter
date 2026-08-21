/**
 * Human phrases for the streaming progress preview (Havn board card #97).
 *
 * The preview used to print the raw tool name (">> bash...") which reads as
 * debug output to a non-technical owner. Tool names arrive here in every
 * shape both runtimes produce: the agent-sdk capitalizes (Bash, WebSearch),
 * the ai-sdk lane is lowercase with underscores (bash, web_search), and MCP
 * tools come as mcp__server__tool. All of them normalize into a category
 * with a small pool of phrasings.
 *
 * Consecutive calls rotate through a category's pool, so a long run reads
 * with gentle variety ("Running a command...", "Working in the terminal...")
 * instead of the same line stamped over and over. Rotation is a per-category
 * counter, not randomness, so the sequence is predictable and testable.
 */

interface Category {
  /** Normalized names (lowercase, no underscores) that map here. */
  names: string[]
  /** Substrings of the normalized name that also map here. */
  contains?: string[]
  phrases: string[]
}

const CATEGORIES: Category[] = [
  {
    names: ['bash', 'shell', 'exec', 'command'],
    phrases: ['Running a command', 'Working in the terminal'],
  },
  {
    names: ['read', 'readfile', 'cat'],
    phrases: ['Reading files', 'Looking through files'],
  },
  {
    names: ['write', 'edit', 'notebookedit', 'multiedit'],
    phrases: ['Updating files', 'Making edits'],
  },
  {
    names: ['grep', 'glob', 'find', 'ls'],
    phrases: ['Searching the project', 'Digging through files'],
  },
  {
    names: ['websearch'],
    phrases: ['Searching the web', 'Looking that up online'],
  },
  {
    names: ['webfetch', 'fetch'],
    phrases: ['Reading a web page', 'Pulling up a page'],
  },
  {
    names: ['task', 'agent', 'subagent'],
    phrases: ['Handing this to a helper', 'A helper is on it'],
  },
  {
    names: ['todowrite', 'todoread', 'todo'],
    phrases: ['Planning the steps', 'Organizing the work'],
  },
  {
    // Browser automation, whichever MCP server provides it.
    names: [],
    contains: ['browser', 'playwright', 'chrome'],
    phrases: ['Browsing the web', 'Working in the browser'],
  },
]

const FALLBACK: string[] = [
  'Working on it',
  'On it',
  'Thinking it through',
  'Putting the pieces together',
  'Still at it',
]

/** "WebSearch" / "web_search" / "web-search" all become "websearch". */
function normalize(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * "mcp__kanban-zone__create_card" → "kanban zone"; null when not an MCP name.
 * Server names can contain single underscores (mcp__claude_ai_Notion__...),
 * so capture lazily up to the double-underscore separator.
 */
function mcpServer(toolName: string): string | null {
  const m = /^mcp__(.+?)__/.exec(toolName)
  return m ? m[1].replace(/[-_.]+/g, ' ') : null
}

// Rotation state: one counter per phrase pool, keyed by the pool's first
// phrase (pools are static, so that key is stable and unique).
const rotation = new Map<string, number>()

function pickFrom(pool: string[]): string {
  const key = pool[0]
  const n = rotation.get(key) ?? 0
  rotation.set(key, n + 1)
  return pool[n % pool.length]
}

/** Test hook: make rotation start from the first phrase again. */
export function resetWorkingPhrases(): void {
  rotation.clear()
}

/**
 * The phrase shown to the owner while a tool runs. Always human words,
 * never the raw tool name.
 */
export function workingPhrase(toolName: string): string {
  const norm = normalize(toolName)

  for (const cat of CATEGORIES) {
    if (cat.names.includes(norm)) return pickFrom(cat.phrases)
    if (cat.contains?.some((c) => norm.includes(c))) return pickFrom(cat.phrases)
  }

  // MCP tools name their server; that is informative enough to show.
  const server = mcpServer(toolName)
  if (server) return pickFrom([`Working in ${server}`, `Still in ${server}`])

  return pickFrom(FALLBACK)
}
