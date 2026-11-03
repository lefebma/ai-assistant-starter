/**
 * Which runtime wrote each agent session (card #270).
 *
 * The claude and ai-sdk runtimes keep separate session stores, and a chat's
 * runtime can change under it: a /model switch, a key removed, managed AI
 * switched on, AGENT_RUNTIME edited. Resuming a session on the runtime that
 * did not write it fails (claude) or silently loses the history (ai-sdk), so
 * runAgent checks the stamp and starts fresh on a mismatch.
 *
 * Lookups never throw: without the database (tests, early boot) the check is
 * skipped, which is the behaviour before this file existed.
 */
import { getAppState, setAppState } from '../db.js'

const key = (sessionId: string) => `session_runtime:${sessionId}`

/** The runtime that wrote this session; null if never stamped; undefined if unknown (no database). */
export function sessionRuntimeOf(sessionId: string): string | null | undefined {
  try {
    return getAppState(key(sessionId))
  } catch {
    return undefined
  }
}

export function stampSessionRuntime(sessionId: string, runtimeId: string): void {
  try {
    if (getAppState(key(sessionId)) !== runtimeId) setAppState(key(sessionId), runtimeId)
  } catch {
    /* no database: nothing to stamp */
  }
}
