/**
 * Agent turns run off the platform's message loop (card #232).
 *
 * grammY's bot.start() handles updates one at a time and awaits each handler.
 * When a handler awaited the whole agent turn, every other update (including
 * /steer, the busy-chat check, and /cancel) sat behind the turn it was meant to
 * affect. Handlers now enqueue the turn and return, so the loop keeps flowing
 * while this queue runs turns one at a time in arrival order. That keeps the
 * old global ordering (runtime state like the loop guard and pending steer
 * isn't safe for concurrent turns) while commands take effect immediately.
 * Each turn gets its own AbortSignal, which /cancel and shutdown fire.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type TurnTask = (signal: AbortSignal) => Promise<void>

interface QueuedTurn {
  chatId: string
  task: TurnTask
  dropped: boolean
  /** Told when /cancel drops the turn before it starts, so a caller awaiting it is not left hanging. */
  onDropped?: () => void
}

export interface CancelResult {
  /** A turn for this chat was running and has been signalled to stop. */
  stoppedActive: boolean
  /** Turns for this chat that were waiting and will now be skipped. */
  droppedQueued: number
}

export function createTurnQueue(onError: (chatId: string, err: unknown) => void) {
  let tail: Promise<void> = Promise.resolve()
  const waiting: QueuedTurn[] = []
  let active: { chatId: string; controller: AbortController } | null = null

  async function runOne(turn: QueuedTurn): Promise<void> {
    const idx = waiting.indexOf(turn)
    if (idx !== -1) waiting.splice(idx, 1)
    if (turn.dropped) {
      try { turn.onDropped?.() } catch { /* the caller's problem, not the queue's */ }
      return
    }
    const controller = new AbortController()
    active = { chatId: turn.chatId, controller }
    try {
      await turn.task(controller.signal)
    } catch (err) {
      // A throwing onError must not reject `tail`: that would skip every later turn.
      try { onError(turn.chatId, err) } catch { /* nothing left to report to */ }
    } finally {
      active = null
    }
  }

  return {
    /** Queue a turn. Returns how many turns are ahead of it (0 = starts now). */
    enqueue(chatId: string, task: TurnTask, onDropped?: () => void): number {
      // The turn runs later but keeps the caller's context: an approval card's
      // run key (#229) and actor must reach the turn it queued. The promise
      // chain carries it today; the bind keeps it true if the queue changes.
      const turn: QueuedTurn = { chatId, task: AsyncLocalStorage.bind(task), dropped: false, onDropped }
      const ahead = waiting.length + (active ? 1 : 0)
      waiting.push(turn)
      tail = tail.then(() => runOne(turn))
      return ahead
    },

    /** Stop this chat's running turn and drop its queued ones. Other chats are untouched. */
    cancel(chatId: string): CancelResult {
      let droppedQueued = 0
      for (const turn of waiting) {
        if (turn.chatId === chatId && !turn.dropped) {
          turn.dropped = true
          droppedQueued++
        }
      }
      const stoppedActive = !!active && active.chatId === chatId && !active.controller.signal.aborted
      if (stoppedActive) active!.controller.abort()
      return { stoppedActive, droppedQueued }
    },

    /** Stop every chat's running turn and drop everything queued (shutdown). */
    cancelAll(): CancelResult {
      let droppedQueued = 0
      for (const turn of waiting) {
        if (!turn.dropped) {
          turn.dropped = true
          droppedQueued++
        }
      }
      const stoppedActive = !!active && !active.controller.signal.aborted
      if (stoppedActive) active!.controller.abort()
      return { stoppedActive, droppedQueued }
    },

    /** Whether a turn for this chat is running or waiting. */
    has(chatId: string): boolean {
      return active?.chatId === chatId || waiting.some((t) => t.chatId === chatId && !t.dropped)
    },

    /** Resolves once everything queued so far has finished (tests, shutdown). */
    idle(): Promise<void> {
      return tail
    },
  }
}

/** Reply text for /cancel, covering chat turns and scheduled runs (kept here so it tests without bot.ts). */
export function describeCancel(
  turns: { stoppedActive: boolean; droppedQueued: number },
  scheduled: { stopped: string[]; retriesCleared: string[]; pausedOneShots?: string[] },
): string {
  const parts: string[] = []
  if (turns.stoppedActive) parts.push('Stopping the current reply.')
  if (turns.droppedQueued) parts.push(`Dropped ${turns.droppedQueued} queued message${turns.droppedQueued === 1 ? '' : 's'}.`)
  if (scheduled.stopped.length) parts.push(`Stopping scheduled: ${scheduled.stopped.join(', ')}.`)
  if (scheduled.retriesCleared.length) parts.push(`Cleared pending retry: ${scheduled.retriesCleared.join(', ')}.`)
  const paused = scheduled.pausedOneShots ?? []
  if (paused.length) {
    parts.push(`One-shot ${paused.length === 1 ? 'task' : 'tasks'} paused so ${paused.length === 1 ? 'it doesn\'t' : 'they don\'t'} re-fire: ${paused.join(', ')} (/schedule resume or /schedule delete).`)
  }
  return parts.length ? parts.join(' ') : 'Nothing running.'
}
