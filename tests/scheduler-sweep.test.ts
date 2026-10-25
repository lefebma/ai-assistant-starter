/**
 * Card #234: runs a previous process left mid-way are found at boot, marked
 * unknown, and reported to the owner with what the effect journal shows. An
 * active one-shot is resumed under the same run key, through the live grant.
 * Real db (own store dir), agent mocked.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-schedsweep-${process.pid}`
  return { runAgent: vi.fn(), sent: [] as Array<[string, string]> }
})

vi.mock('../src/agent.js', () => ({
  runAgent: h.runAgent,
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))

import { initDatabase, createTask, getTask, pauseTask, setTaskRole, markTaskRunning, updateTaskAfterRun } from '../src/db.js'
import {
  RESUME_MARK, abortAllScheduledRuns, initScheduler, runDueTasks, stopScheduler, sweepInterruptedRuns, sweepMessage,
} from '../src/scheduler.js'
import { beginEffect, commitEffect, currentRun, jobRunKey } from '../src/assurance/effect-journal.js'
import { currentGrant } from '../src/assurance/grant.js'
import { loadRunState, openRun } from '../src/assurance/run-state.js'

rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })

const nowS = () => Math.floor(Date.now() / 1000)
const due = () => nowS() - 60
const send = async (chatId: string, text: string) => { h.sent.push([chatId, text]) }
const alerts = () => h.sent.filter(([, t]) => !t.startsWith('Running:'))
const OBLIGATIONS = [{ id: 'email', description: 'Reminder sent', evidenceType: 'email.sent' }]

/** What a crash leaves: the row marked running, an email already sent under the run key. */
function crashedOneShot(id: string, opts: { sent?: string[]; pending?: string[]; silent?: boolean } = {}) {
  createTask(id, 'chat-sw', `Follow up ${id}`, '0 9 * * *', due(), `Job ${id}`, opts.silent ? 'silent' : 'announce', 'America/Toronto', true)
  const runKey = jobRunKey(id, 0, true)
  markTaskRunning(id, runKey, due() + 86_400)
  for (const to of opts.sent ?? []) {
    const c = beginEffect({ kind: 'email.send', target: `${to}|reminder`, recipients: [to] }, runKey)
    if (c.ok) commitEffect(c.key)
  }
  for (const to of opts.pending ?? []) beginEffect({ kind: 'email.send', target: `${to}|reminder`, recipients: [to] }, runKey)
  return runKey
}

beforeAll(async () => {
  initDatabase()
  initScheduler(send)
  stopScheduler()
  await new Promise((r) => setTimeout(r, 10))
  h.sent.length = 0
})

afterEach(() => {
  h.runAgent.mockReset()
  h.sent.length = 0
})

describe('boot sweep', () => {
  it('a crashed one-shot is reported, re-queued under the same run key, and resumed with a continuation prompt', async () => {
    const runKey = crashedOneShot('sw-1', { sent: ['billing@northpine.example'] })
    const swept = await sweepInterruptedRuns(send)
    expect(swept).toMatchObject([{ taskId: 'sw-1', action: 'resumed', runKey, alerted: true }])
    expect(getTask('sw-1')).toMatchObject({ last_result: RESUME_MARK, run_key: runKey })
    expect(getTask('sw-1')!.next_run).toBeLessThanOrEqual(nowS())
    const [[chat, text]] = alerts()
    expect(chat).toBe('chat-sw')
    expect(text).toContain('"Job sw-1" was cut off when the assistant stopped unexpectedly')
    expect(text).toContain('Already went out: email.send to billing@northpine.example.')
    expect(text).toContain('Picking it up again now')

    // The resumed run: same run key, so the email is refused rather than sent twice.
    let seen: { run?: string; prompt?: string; repeat?: boolean } = {}
    h.runAgent.mockImplementationOnce(async (prompt: string) => {
      seen = { run: currentRun(), prompt, repeat: !beginEffect({ kind: 'email.send', target: 'billing@northpine.example|reminder' }).ok }
      return { text: 'Done.' }
    })
    await runDueTasks()
    expect(seen.run).toBe(runKey)
    expect(seen.repeat).toBe(true)
    expect(seen.prompt).toMatch(/stopped partway because the assistant restarted/)
    expect(seen.prompt).toContain('Follow up sw-1')
    expect(getTask('sw-1')).toBeUndefined() // one-shot completed and deleted
  })

  it('saved obligation evidence from before the crash is there for the resumed run', async () => {
    const runKey = crashedOneShot('sw-2')
    const first = openRun(runKey, OBLIGATIONS).authority
    first.record({ eventId: 'msg-1', runId: runKey, origin: 'tool', evidenceType: 'email.sent', obligationId: 'email' })
    await sweepInterruptedRuns(send)
    h.runAgent.mockImplementationOnce(async () => {
      expect(openRun(runKey, OBLIGATIONS).authority.requestCompletion().status).toBe('complete')
      return { text: 'Done.' }
    })
    await runDueTasks()
    expect(h.runAgent).toHaveBeenCalledTimes(1)
  })

  it('resuming re-checks the grant: a role narrowed since the crash is the one the resumed run gets', async () => {
    crashedOneShot('sw-3')
    setTaskRole('sw-3', 'briefing')
    await sweepInterruptedRuns(send)
    let grant: ReturnType<typeof currentGrant> = null
    h.runAgent.mockImplementationOnce(async () => { grant = currentGrant(); return { text: 'Done.' } })
    await runDueTasks()
    expect(grant).toEqual({ ok: true, role: 'briefing', taskId: 'sw-3' })
  })

  it('a paused task is not resumed; its run is marked unknown and the owner is told', async () => {
    const runKey = crashedOneShot('sw-4', { pending: ['ap@client.example'] })
    openRun(runKey, OBLIGATIONS)
    pauseTask('sw-4')
    const [r] = await sweepInterruptedRuns(send)
    expect(r).toMatchObject({ action: 'paused', unconfirmed: [expect.objectContaining({ status: 'pending' })] })
    expect(getTask('sw-4')).toMatchObject({ status: 'paused', run_key: null })
    expect(getTask('sw-4')!.last_result).toMatch(/^UNKNOWN: cut off/)
    expect(loadRunState(runKey)!.terminal).toMatchObject({ status: 'unknown' })
    const [[, text]] = alerts()
    expect(text).toContain('Started but never confirmed (check Sent before asking again): email.send to ap@client.example.')
    expect(text).toContain('The task is paused')
    await runDueTasks()
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('a recurring run is not replayed: marked unknown, told when it runs next', async () => {
    createTask('sw-5', 'chat-sw', 'Daily digest', '0 9 * * *', due(), 'Digest', 'announce', 'America/Toronto', false)
    const runKey = jobRunKey('sw-5', due(), false)
    const next = due() + 86_400
    markTaskRunning('sw-5', runKey, next)
    const [r] = await sweepInterruptedRuns(send)
    expect(r).toMatchObject({ action: 'next-run', runKey })
    expect(getTask('sw-5')).toMatchObject({ next_run: next, run_key: null })
    expect(alerts()[0][1]).toContain('It runs again at its next scheduled time (')
    await runDueTasks()
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('a lost deferred retry is found too', async () => {
    createTask('sw-6', 'chat-sw', 'Retry me', '0 9 * * *', due(), 'Retry job', 'announce', 'America/Toronto', true)
    updateTaskAfterRun('sw-6', 'DEFERRED: API overloaded, retrying in 10 min', due() + 86_400, jobRunKey('sw-6', 0, true))
    const [r] = await sweepInterruptedRuns(send)
    expect(r.action).toBe('resumed')
    expect(alerts()[0][1]).toContain('cut off by a restart while it waited to retry')
    h.runAgent.mockResolvedValueOnce({ text: 'Done.' })
    await runDueTasks()
    expect(getTask('sw-6')).toBeUndefined()
  })

  it('a silent job with nothing recorded is resumed without paging the owner', async () => {
    crashedOneShot('sw-7', { silent: true })
    const [r] = await sweepInterruptedRuns(send)
    expect(r).toMatchObject({ action: 'resumed', alerted: false })
    expect(alerts()).toEqual([])
    h.runAgent.mockResolvedValueOnce({ text: 'NO_REPLY' })
    await runDueTasks()
  })

  it('a row from before the run_key column (bare RUNNING...) is still found', async () => {
    createTask('sw-8', 'chat-sw', 'Old', '0 9 * * *', due() + 86_400, 'Old job', 'announce', 'America/Toronto', true)
    updateTaskAfterRun('sw-8', 'RUNNING...', due() + 86_400)
    const [r] = await sweepInterruptedRuns(send)
    expect(r).toMatchObject({ action: 'resumed', runKey: 'job:sw-8' })
    h.runAgent.mockResolvedValueOnce({ text: 'Done.' })
    await runDueTasks()
  })

  it('cut off again after being resumed: paused, not resumed a second time', async () => {
    crashedOneShot('sw-9')
    await sweepInterruptedRuns(send)
    // The resumed run takes the process down too.
    h.runAgent.mockImplementationOnce((...args: unknown[]) => new Promise((resolve) => (args[6] as AbortSignal).addEventListener('abort', () => resolve({ text: null }), { once: true })))
    const run = runDueTasks()
    await new Promise((r) => setTimeout(r, 10))
    expect(getTask('sw-9')!.last_result).toBe('RUNNING... (resumed)')
    h.sent.length = 0
    const [r] = await sweepInterruptedRuns(send)
    expect(r.action).toBe('paused-again')
    expect(getTask('sw-9')).toMatchObject({ status: 'paused', run_key: null })
    expect(alerts()[0][1]).toContain('second time in a row, so I have paused it')
    abortAllScheduledRuns() // let the hung run unwind
    await run
  })

  it('nothing to sweep after clean runs: the run key is cleared when a run ends', async () => {
    createTask('sw-10', 'chat-sw', 'Fine', '0 9 * * *', due(), 'Fine job', 'announce', 'America/Toronto', false)
    h.runAgent.mockResolvedValueOnce({ text: 'All good.' })
    await runDueTasks()
    expect(getTask('sw-10')).toMatchObject({ last_result: 'All good.', run_key: null })
    expect((await sweepInterruptedRuns(send)).map(r => r.taskId)).not.toContain('sw-10')
  })
})

describe('run key lifecycle', () => {
  it('a one-shot kept back because the AI allowance ran out mid-run is not mistaken for a crash', async () => {
    createTask('sw-12', 'chat-sw', 'Later', '0 9 * * *', due(), 'Later job', 'announce', 'America/Toronto', true)
    h.runAgent.mockResolvedValueOnce({ text: null, aiPaused: 'limit' })
    await runDueTasks()
    expect(getTask('sw-12')).toMatchObject({ status: 'active', run_key: null })
    expect((await sweepInterruptedRuns(send)).map(r => r.taskId)).not.toContain('sw-12')
  })
})

describe('shutdown', () => {
  it('a run stopped by shutdown keeps its key and reads as a restart, not a crash', async () => {
    createTask('sw-11', 'chat-sw', 'Long', '0 9 * * *', due(), 'Long job', 'announce', 'America/Toronto', true)
    let started!: () => void
    const running = new Promise<void>((r) => { started = r })
    h.runAgent.mockImplementationOnce((...args: unknown[]) => {
      const signal = args[6] as AbortSignal
      started()
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: null }), { once: true }))
    })
    const run = runDueTasks()
    await running
    expect(abortAllScheduledRuns()).toBe(1)
    await run
    expect(getTask('sw-11')).toMatchObject({ last_result: 'INTERRUPTED: stopped by a restart', run_key: 'job:sw-11' })
    h.sent.length = 0
    const [r] = await sweepInterruptedRuns(send)
    expect(r.action).toBe('resumed')
    expect(alerts()[0][1]).toContain('"Long job" was cut off by a restart')
    h.runAgent.mockResolvedValueOnce({ text: 'Done.' })
    await runDueTasks()
  })
})

describe('sweepMessage', () => {
  it('says plainly what is known', () => {
    expect(sweepMessage({ label: 'X', action: 'resumed', done: [], unconfirmed: [] }, 'by a restart'))
      .toBe('"X" was cut off by a restart, so I can\'t tell whether it finished.\nNothing it sends was recorded as going out.\nPicking it up again now. Anything that already went out will not be sent twice.')
  })
})
