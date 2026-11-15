/**
 * A turn that hit a failing tool and then ended with no answer at all looks, from
 * the outside, like a quiet success: Telegram shows "(no response)" or nothing, and
 * a silent scheduled task looks healthy while it is actually broken. This builds the
 * one-line note that says what failed instead.
 *
 * Only a blank reply gets the note. When the model wrote anything, it already
 * had a chance to explain, and bolting a warning onto every reply that saw a
 * tool error (many are recovered from within the turn) would just be noise.
 *
 * Pure functions, no imports, so tests can exercise them directly.
 */

/** Ordered unique tool names whose result came back as an error. */
export function failedToolNames(calls: Map<string, string>, erroredIds: Iterable<string>): string[] {
  const out: string[] = []
  for (const id of erroredIds) {
    const name = calls.get(id) ?? 'a tool'
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** The note to deliver when the turn ended blank after tool failures, or null when no note is needed. */
export function toolFailureNotice(finalText: string | null | undefined, failed: string[]): string | null {
  if (failed.length === 0) return null
  if (finalText && finalText.trim().length > 0) return null
  const shown = failed.slice(0, 4).join(', ') + (failed.length > 4 ? ', ...' : '')
  return (
    `That turn ended without an answer after ${failed.length === 1 ? 'a tool call failed' : 'tool calls failed'}: ${shown}. ` +
    `Treat whatever it was meant to do as not done. Ask me to try again.`
  )
}
