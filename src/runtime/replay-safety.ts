/**
 * Which tool calls are safe to run twice.
 *
 * The Claude runtime retries a turn that dies on a transient API error (429, 529,
 * 503) by replaying the same message. That is fine when the failed attempt only
 * read things. It is not fine when the attempt already sent an email, wrote a
 * file or created an event: the replay would do it again. A tool that is not
 * clearly read-only counts as unsafe, so a doubtful call stops the retry
 * rather than risking a duplicate side effect.
 *
 * Pure functions, no imports, so tests can exercise them directly.
 */

const READ_ONLY_BUILT_INS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'TodoWrite'])

/** MCP tools known to be read-only whatever their name looks like. */
const READ_ONLY_MCP_TOOLS = new Set(['API-query-data-source', 'API-post-search'])

/** The tool name starts with a read verb. */
const READ_VERB = /^(?:API-)?(?:get|list|retrieve|search|read|find|describe)(?:[-_]|$)/i

/**
 * A word anywhere in the name that says it changes something. A read verb up front is
 * not enough: `get_and_delete_scene` starts like a read and is not one.
 */
const MUTATING_WORD = new Set([
  'create', 'update', 'delete', 'remove', 'replace', 'set', 'add', 'send', 'mark', 'post', 'patch', 'put',
  'write', 'move', 'archive', 'publish', 'run', 'exec', 'execute', 'generate', 'import', 'upload', 'invoke',
  'apply', 'commit', 'approve', 'reject', 'cancel', 'start', 'stop', 'trigger', 'enable', 'disable', 'upsert',
  'insert', 'drop', 'clear', 'reset', 'edit', 'save', 'submit', 'deploy', 'merge', 'rename', 'transform',
  'click', 'type', 'fill', 'press', 'drag', 'navigate', 'share', 'invite', 'revoke', 'connect', 'register',
])

export function isReplaySafeTool(name: string): boolean {
  if (READ_ONLY_BUILT_INS.has(name)) return true
  if (!name.startsWith('mcp__')) return false
  // mcp__<server>__<tool>: the tool is everything after the second `__`.
  const tool = name.split('__').slice(2).join('__')
  if (!tool) return false
  if (READ_ONLY_MCP_TOOLS.has(tool)) return true
  if (!READ_VERB.test(tool)) return false
  return !tool.split(/[-_]/).some((word) => MUTATING_WORD.has(word.toLowerCase()))
}

/** Unique names of the tools in `used` that are not safe to replay, in first-seen order. */
export function unsafeToolNames(used: Iterable<string>): string[] {
  const out: string[] = []
  for (const name of used) if (!isReplaySafeTool(name) && !out.includes(name)) out.push(name)
  return out
}

/**
 * What the user is told when a retry is refused. It must not contain the words the
 * scheduler keys off to defer and re-run a whole task (overloaded, rate limit, 429,
 * 529), or the scheduler would replay the very thing this refused to replay.
 */
export function noRetryNotice(tools: string[]): string {
  const shown = tools.slice(0, 5).join(', ') + (tools.length > 5 ? ', ...' : '')
  return (
    `The API returned a temporary error partway through this turn, after I had already run: ${shown}. ` +
    `I did not retry on my own, so nothing runs twice. Check what got done first, then tell me to carry on.`
  )
}
