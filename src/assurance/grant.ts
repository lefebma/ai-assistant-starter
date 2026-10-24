/**
 * Authority checked at the moment of each effect, not only when a run starts
 * (card #230, from spikes #217 and #218).
 *
 * A scheduled run carries a live grant: a check the gate calls before every
 * tool call. It rereads the task, so an owner who pauses or deletes the job,
 * or changes its role, is obeyed from the next call on, mid-run, in a
 * deferred retry, in a subagent or in a steered follow-up alike. The run's
 * tools then follow the role the task has now, not the one it started with.
 *
 * Chat has no live grant: the owner is in the conversation.
 *
 * Carried like the effect journal's run key (AsyncLocalStorage), so everything
 * the run does, however deep, sees it. A check that throws fails closed.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** `role` null means the task has no role: every tool, as in chat. */
export type Grant = { ok: true; role: string | null; taskId?: string } | { ok: false; reason: string }

const grantStore = new AsyncLocalStorage<() => Grant>()

export function withGrant<T>(check: () => Grant, fn: () => T): T {
  return grantStore.run(check, fn)
}

/** The grant as it stands right now, or null when this run has none. */
export function currentGrant(): Grant | null {
  const check = grantStore.getStore()
  if (!check) return null
  try {
    return check()
  } catch (err) {
    return { ok: false, reason: `the grant could not be checked (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** What a scheduled job's live grant reads: the task row as it is now. */
export function taskGrant(taskId: string, read: (id: string) => { status: string; role?: string | null } | undefined): () => Grant {
  return () => {
    const t = read(taskId)
    if (!t) return { ok: false, reason: 'the owner deleted this scheduled task' }
    if (t.status !== 'active') return { ok: false, reason: 'the owner paused this scheduled task' }
    return { ok: true, role: t.role ?? null, taskId }
  }
}
