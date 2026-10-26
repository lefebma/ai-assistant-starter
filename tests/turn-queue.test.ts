/**
 * tests/turn-queue.test.ts
 * Verifies src/turn-queue.ts: strict global-arrival-order execution, the
 * enqueue "turns ahead" count, per-chat cancel semantics (abort active,
 * drop queued), error isolation via onError, and idle() draining. Ported from
 * Umi with card #232, plus cancelAll (shutdown), has() and context carry-over.
 */
import { describe, it, expect, vi } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createTurnQueue, describeCancel } from '../src/turn-queue.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Lets a just-enqueued turn actually begin (task body runs up to its first
// await) before the next assertion, without resolving that task.
async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

describe('turn-queue', () => {
  it('should run turns strictly one at a time in arrival order', async () => {
    const onError = vi.fn()
    const queue = createTurnQueue(onError)
    const order: string[] = []
    const d1 = deferred<void>()

    let secondStarted = false
    queue.enqueue('chatA', async () => {
      order.push('first-start')
      await d1.promise
      order.push('first-end')
    })
    queue.enqueue('chatB', async () => {
      secondStarted = true
      order.push('second-start')
      order.push('second-end')
    })

    await flush()
    expect(order).toEqual(['first-start'])
    expect(secondStarted).toBe(false)

    d1.resolve()
    await queue.idle()
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })

  it('should report 0 turns ahead when the queue is idle', () => {
    const queue = createTurnQueue(vi.fn())
    const ahead = queue.enqueue('chatA', async () => {})
    expect(ahead).toBe(0)
  })

  it('should report 1 turn ahead when one turn is already running', async () => {
    const queue = createTurnQueue(vi.fn())
    const d1 = deferred<void>()
    queue.enqueue('chatA', async () => {
      await d1.promise
    })
    await flush() // let the first turn actually start (active is now set)

    const ahead = queue.enqueue('chatB', async () => {})
    expect(ahead).toBe(1)

    d1.resolve()
    await queue.idle()
  })

  it('should report 2 turns ahead when one is running and one is waiting', async () => {
    const queue = createTurnQueue(vi.fn())
    const d1 = deferred<void>()
    const d2 = deferred<void>()
    queue.enqueue('chatA', async () => {
      await d1.promise
    })
    await flush()
    queue.enqueue('chatB', async () => {
      await d2.promise
    })

    const ahead = queue.enqueue('chatC', async () => {})
    expect(ahead).toBe(2)

    d1.resolve()
    d2.resolve()
    await queue.idle()
  })

  it('should abort only the matching chat active signal and report stoppedActive true', async () => {
    const queue = createTurnQueue(vi.fn())
    const d1 = deferred<void>()
    let sawAbort = false
    queue.enqueue('chatA', async (signal) => {
      signal.addEventListener('abort', () => {
        sawAbort = true
      })
      await d1.promise
    })
    await flush()

    const result = queue.cancel('chatA')
    expect(result.stoppedActive).toBe(true)
    expect(result.droppedQueued).toBe(0)
    expect(sawAbort).toBe(true)

    d1.resolve()
    await queue.idle()
  })

  it('should leave another chat active turn running when cancel targets a different chat', async () => {
    const queue = createTurnQueue(vi.fn())
    const d1 = deferred<void>()
    let sawAbort = false
    queue.enqueue('chatA', async (signal) => {
      signal.addEventListener('abort', () => {
        sawAbort = true
      })
      await d1.promise
    })
    await flush()

    const result = queue.cancel('chatB')
    expect(result.stoppedActive).toBe(false)
    expect(result.droppedQueued).toBe(0)
    expect(sawAbort).toBe(false)

    d1.resolve()
    await queue.idle()
  })

  it('should drop only the matching chat queued turns and never run their tasks', async () => {
    const queue = createTurnQueue(vi.fn())
    const dActive = deferred<void>()
    const ranA2 = vi.fn()
    const ranB = vi.fn()

    // chatA turn 1: running (blocks the queue)
    queue.enqueue('chatA', async () => {
      await dActive.promise
    })
    await flush()
    // chatA turn 2: queued, should be dropped by cancel('chatA')
    queue.enqueue('chatA', ranA2)
    // chatB turn: queued, unrelated chat, must still run
    queue.enqueue('chatB', ranB)

    const result = queue.cancel('chatA')
    expect(result.stoppedActive).toBe(true)
    expect(result.droppedQueued).toBe(1)

    dActive.resolve()
    await queue.idle()

    expect(ranA2).not.toHaveBeenCalled()
    expect(ranB).toHaveBeenCalledTimes(1)
  })

  it('should not double-report stoppedActive on a second cancel of the same chat', async () => {
    const queue = createTurnQueue(vi.fn())
    const d1 = deferred<void>()
    queue.enqueue('chatA', async () => {
      await d1.promise
    })
    await flush()

    const first = queue.cancel('chatA')
    const second = queue.cancel('chatA')
    expect(first.stoppedActive).toBe(true)
    expect(second.stoppedActive).toBe(false)

    d1.resolve()
    await queue.idle()
  })

  it('should call onError when a task throws and continue running later tasks', async () => {
    const onError = vi.fn()
    const queue = createTurnQueue(onError)
    const err = new Error('boom')
    const ranNext = vi.fn()

    queue.enqueue('chatA', async () => {
      throw err
    })
    queue.enqueue('chatB', ranNext)

    await queue.idle()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('chatA', err)
    expect(ranNext).toHaveBeenCalledTimes(1)
  })

  it('should resolve idle() only after every enqueued task has finished', async () => {
    const queue = createTurnQueue(vi.fn())
    const done = { a: false, b: false, c: false }
    queue.enqueue('chatA', async () => {
      done.a = true
    })
    queue.enqueue('chatB', async () => {
      done.b = true
    })
    queue.enqueue('chatC', async () => {
      done.c = true
    })

    await queue.idle()

    expect(done).toEqual({ a: true, b: true, c: true })
  })

  it('cancelAll aborts whichever chat is running and drops every queued turn (shutdown)', async () => {
    const queue = createTurnQueue(() => {})
    const gate = deferred()
    let signal: AbortSignal | undefined
    const ran: string[] = []
    queue.enqueue('a', async (s) => { signal = s; await gate.promise })
    queue.enqueue('b', async () => { ran.push('b') })
    queue.enqueue('c', async () => { ran.push('c') })
    await flush()
    expect(queue.has('a')).toBe(true)
    expect(queue.has('b')).toBe(true)
    expect(queue.cancelAll()).toEqual({ stoppedActive: true, droppedQueued: 2 })
    expect(signal?.aborted).toBe(true)
    expect(queue.has('b')).toBe(false)
    gate.resolve()
    await queue.idle()
    expect(ran).toEqual([])
    expect(queue.has('a')).toBe(false)
  })

  it("a queued turn runs in its caller's context, so an approval card's run key reaches it", async () => {
    const queue = createTurnQueue(() => {})
    const store = new AsyncLocalStorage<string>()
    const gate = deferred()
    const seen: Array<string | undefined> = []
    queue.enqueue('a', async () => { await gate.promise })
    store.run('card:chat:42', () => { queue.enqueue('a', async () => { seen.push(store.getStore()) }) })
    queue.enqueue('a', async () => { seen.push(store.getStore()) })
    gate.resolve()
    await queue.idle()
    expect(seen).toEqual(['card:chat:42', undefined])
  })

  it('a turn dropped before it starts tells its waiter', async () => {
    const queue = createTurnQueue(() => {})
    const gate = deferred()
    const dropped = vi.fn()
    queue.enqueue('a', async () => { await gate.promise })
    queue.enqueue('a', async () => {}, dropped)
    queue.cancel('a')
    gate.resolve()
    await queue.idle()
    expect(dropped).toHaveBeenCalledTimes(1)
  })

  it('describeCancel says what stopped, or that nothing was running', () => {
    expect(describeCancel({ stoppedActive: false, droppedQueued: 0 }, { stopped: [], retriesCleared: [] })).toBe('Nothing running.')
    expect(describeCancel({ stoppedActive: true, droppedQueued: 2 }, { stopped: ['Briefing'], retriesCleared: ['Triage'], pausedOneShots: ['t1'] }))
      .toBe("Stopping the current reply. Dropped 2 queued messages. Stopping scheduled: Briefing. Cleared pending retry: Triage. One-shot task paused so it doesn't re-fire: t1 (/schedule resume or /schedule delete).")
  })

  it('describeCancel counts a voice call it ended and the lookups it stopped', () => {
    const none = { stopped: [], retriesCleared: [] }
    expect(describeCancel({ stoppedActive: false, droppedQueued: 0 }, none, { calls: 1, runs: 0 })).toBe('Ended the voice call.')
    expect(describeCancel({ stoppedActive: false, droppedQueued: 0 }, none, { calls: 2, runs: 1 })).toBe('Ended 2 voice calls. Stopped 1 lookup the call started.')
    expect(describeCancel({ stoppedActive: false, droppedQueued: 0 }, none, { calls: 0, runs: 0 })).toBe('Nothing running.')
  })
})
