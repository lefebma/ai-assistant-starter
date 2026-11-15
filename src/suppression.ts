/**
 * Scheduled-task output suppression.
 *
 * A silent scheduled run is not delivered to Telegram when it is a "nothing to
 * say" signal: one of these tokens standing alone, either as the whole result or
 * as the last line after a sentence of explanation (several silent tasks end
 * "No changes detected...\n\nNO_REPLY"). Markdown emphasis, quotes, code ticks
 * and trailing punctuation around the token are ignored.
 *
 * It used to be a substring match, so a real report that merely quoted a token
 * ("the NO_REPLY rule dropped Tuesday's digest") vanished without a trace. A
 * token inside a sentence, or on any line but the last, no longer counts.
 *
 * Lives in a leaf module so the scheduler, its tests, and the eval harness's
 * workload heartbeat tasks all use the one real rule.
 */
export const SUPPRESSION_PATTERNS = ['HEARTBEAT_OK', 'NO_REPLY', 'NO_ACTION', 'NOTHING_TO_REPORT'] as const

/** Decoration a model may wrap around a bare token: `**NO_REPLY**`, "`HEARTBEAT_OK`", `NO_REPLY.` */
const WRAPPERS = /^[\s*_`'"“”‘’<>()[\]]+|[\s*_`'"“”‘’<>()[\]]+$|[.!]+$/g

function isBareToken(line: string): boolean {
  return (SUPPRESSION_PATTERNS as readonly string[]).includes(line.replace(WRAPPERS, ''))
}

export function shouldSuppressResult(result: string): boolean {
  const lines = result.trim().split('\n')
  return isBareToken(lines[lines.length - 1] ?? '')
}
