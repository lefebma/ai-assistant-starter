/**
 * Card #232: cancelling a scheduled run reaches the run, a pending overload
 * retry, and the retry's own run. Real db (own store dir), agent mocked: a
 * "running" job is a runAgent call that waits for its signal, the way both
 * runtimes resolve a cancelled turn (text null).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-schedcancel`
  return { runAgent: vi.fn(), sent: [] as Array<[string, string]> }
})

vi.mock('../src/agent.js', () => ({
  runAgent: h.runAgent,
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))

import { initDatabase, createTask, getTask } from '../src/db.js'
import {
  abortAllScheduledRuns, cancelScheduledForChat, cancelScheduledTask, initScheduler, isScheduledTaskRunning, runDueTasks, stopScheduler,
} from '../src/scheduler.js'

rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })

const OVERLOADED = 'API is temporarily overloaded. Try again shortly.'
const due = () => Math.floor(Date.now() / 1000) - 60

/** A runAgent that runs until its signal aborts, then resolves like a cancelled turn. */
function runsUntilCancelled(): { started: Promise<AbortSignal> } {
  let started!: (s: AbortSignal) => void
  const p = new Promise<AbortSignal>((r) => { started = r })
  h.runAgent.mockImplementationOnce((...args: unknown[]) => {
    const signal = args[6] as AbortSignal
    started(signal)
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: null }), { once: true }))
  })
  return { started: p }
}

const results = () => h.sent.filter(([, t]) => !t.startsWith('Running:'))

beforeAll(async () => {
  initDatabase()
  initScheduler(async (chatId, text) => { h.sent.push([chatId, text]) })
  stopScheduler()
  await new Promise((r) => setTimeout(r, 10))
})

afterEach(() => {
  h.runAgent.mockReset()
  h.sent.length = 0
  vi.useRealTimers()
})

describe('cancel a scheduled run in flight', () => {
  it('every run gets a signal; cancel stops it, records CANCELLED and delivers nothing', async () => {
    createTask('c-1', 'chat-a', 'long job', '0 9 * * *', due(), 'Long job', 'announce')
    const job = runsUntilCancelled()
    const run = runDueTasks()
    const signal = await job.started
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(isScheduledTaskRunning('c-1')).toBe(true)

    expect(cancelScheduledTask('c-1')).toEqual({ stopped: ['Long job'], retriesCleared: [], pausedOneShots: [] })
    expect(signal.aborted).toBe(true)
    await run

    expect(getTask('c-1')).toMatchObject({ status: 'active', last_result: 'CANCELLED' })
    expect(results()).toEqual([])
    expect(isScheduledTaskRunning('c-1')).toBe(false)
  })

  it('a cancelled one-shot is paused, not deleted and not re-armed', async () => {
    createTask('c-2', 'chat-a', 'once', '0 9 * * *', due(), 'Once', 'silent', 'America/Toronto', true)
    const job = runsUntilCancelled()
    const run = runDueTasks()
    await job.started
    expect(cancelScheduledTask('c-2').pausedOneShots).toEqual(['c-2'])
    await run
    expect(getTask('c-2')).toMatchObject({ status: 'paused', last_result: 'CANCELLED' })
  })

  it('cancel for a chat stops only that chat\'s runs', async () => {
    createTask('c-3', 'chat-b', 'other chat job', '0 9 * * *', due(), 'Other', 'silent')
    const job = runsUntilCancelled()
    const run = runDueTasks()
    const signal = await job.started
    expect(cancelScheduledForChat('chat-a').stopped).toEqual([])
    expect(signal.aborted).toBe(false)
    expect(cancelScheduledForChat('chat-b').stopped).toEqual(['Other'])
    await run
    expect(signal.aborted).toBe(true)
  })

  it('shutdown aborts the run and marks its row, so the boot sweep picks the one-shot up again (#234)', async () => {
    createTask('c-4', 'chat-a', 'once at shutdown', '0 9 * * *', due(), 'Shut', 'silent', 'America/Toronto', true)
    const job = runsUntilCancelled()
    const run = runDueTasks()
    const signal = await job.started
    expect(abortAllScheduledRuns()).toBe(1)
    await run
    expect(signal.aborted).toBe(true)
    expect(getTask('c-4')).toMatchObject({ status: 'active', last_result: 'INTERRUPTED: stopped by a restart', run_key: 'job:c-4' })
  })
})

describe('cancel reaches the overload retry', () => {
  it('a pending retry is cleared and never runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    createTask('r-1', 'chat-a', 'retry me', '0 9 * * *', due(), 'Retry', 'silent')
    h.runAgent.mockResolvedValueOnce({ text: OVERLOADED, newSessionId: 's1' })
    await runDueTasks()
    expect(getTask('r-1')?.last_result).toMatch(/^DEFERRED/)

    expect(cancelScheduledTask('r-1')).toEqual({ stopped: [], retriesCleared: ['Retry'], pausedOneShots: [] })
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(getTask('r-1')?.last_result).toBe('CANCELLED')
  })

  it('the retry\'s own run gets a signal, and cancel stops it before it delivers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    createTask('r-2', 'chat-a', 'retry and cancel', '0 9 * * *', due(), 'Retry two', 'announce')
    h.runAgent.mockResolvedValueOnce({ text: OVERLOADED, newSessionId: 's2' })
    await runDueTasks()
    const retry = runsUntilCancelled()
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
    const signal = await retry.started
    expect(h.runAgent.mock.calls[1][1]).toBe('s2')
    expect(isScheduledTaskRunning('r-2')).toBe(true)

    expect(cancelScheduledTask('r-2').stopped).toEqual(['Retry two'])
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(results()).toEqual([])
    expect(getTask('r-2')?.last_result).toBe('CANCELLED')
    expect(isScheduledTaskRunning('r-2')).toBe(false)
  })
})
