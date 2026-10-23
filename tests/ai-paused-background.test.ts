/**
 * Task A4: background callers skip their model work while the AI allowance
 * marker is set (and no recovery probe is due), and behave as before otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { runAgentSpy, runtimeSpy } = vi.hoisted(() => {
  // Own store dir: real db and the real marker file live here.
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-aipaused`
  return {
    runAgentSpy: vi.fn(async (..._a: unknown[]) => ({ text: 'done' })),
    runtimeSpy: vi.fn(async (..._a: unknown[]) => 'ready'),
  }
})

vi.mock('../src/agent.js', () => ({
  runAgent: runAgentSpy,
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))
vi.mock('../src/runtime/index.js', () => ({
  getAgentRuntime: () => ({ id: 'fake', runOnce: runtimeSpy, run: runtimeSpy }),
}))

import { initDatabase, createTask, getDb } from '../src/db.js'
import { runDueTasks, initScheduler } from '../src/scheduler.js'
import { writeAiLimit, clearAiLimit, aiPausedNow } from '../src/ai-limit.js'
import { STORE_DIR } from '../src/config.js'

rmSync(STORE_DIR, { recursive: true, force: true })

const pause = (over: Record<string, string> = {}): void =>
  writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString(), ...over })

beforeAll(() => {
  initDatabase()
})
beforeEach(() => {
  runAgentSpy.mockClear()
  runtimeSpy.mockClear()
})
afterEach(() => clearAiLimit())

describe('aiPausedNow', () => {
  it('is false without a marker, true when fresh, false once recovery is due', () => {
    expect(aiPausedNow()).toBe(false)
    pause()
    expect(aiPausedNow()).toBe(true)
    expect(aiPausedNow(new Date(Date.now() + 16 * 60_000))).toBe(false)
  })
})

describe('scheduler while paused', () => {
  it('advances next_run without running or announcing', async () => {
    const sent: string[] = []
    initScheduler(async (_chat: string, text: string) => {
      sent.push(text)
    })
    const due = Math.floor(Date.now() / 1000) - 60
    createTask('paused-1', '123', 'work', '0 9 * * *', due, 'Paused job', 'announce')
    pause()
    await runDueTasks()
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    const row = getDb().prepare('SELECT next_run, last_result FROM scheduled_tasks WHERE id = ?').get('paused-1') as {
      next_run: number
      last_result: string
    }
    expect(row.next_run).toBeGreaterThan(due)
    expect(row.last_result).toBe('SKIPPED: AI allowance used up')
  })

  it('runs normally with no marker', async () => {
    createTask('paused-2', '123', 'real work', '0 9 * * *', Math.floor(Date.now() / 1000) - 60, 'Normal', 'silent')
    await runDueTasks()
    expect(runAgentSpy).toHaveBeenCalled()
  })
})

describe('email alerts tick while paused', () => {
  it('returns zeros and leaves mail unseen (not triaged, not marked seen)', async () => {
    const s = await import('../src/email-alerts/store.js')
    const svc = await import('../src/email-alerts/service.js')
    for (const t of ['email_alert_seen', 'email_alerts']) getDb().exec(`DELETE FROM ${t}`)
    s.saveSettings({
      enabled: true, pauseUntil: null, pauseIndefinite: false, pauseStartedAt: null,
      quietStart: '22:00', quietEnd: '07:00', seededMailboxes: ['a@x.com'], pauseSummaryPending: false,
    })
    const NOON = new Date('2026-10-18T12:00:00Z')
    const mailbox = {
      id: 'a@x.com',
      provider: 'gmail' as const,
      list: async () => [{
        mailbox: 'a@x.com', msgId: 'm1', rfcMessageId: '<r1@x.com>', receivedAt: NOON.getTime() - 1000,
        headers: { from: 'Person <p@client.com>' }, subject: 'Site down',
      }],
      body: async () => 'body',
    }
    const triage = vi.fn(async () => ({ kind: 'verdict' as const, verdict: { critical: true, reason: 'down' } }))
    const send = vi.fn(async () => ({ chatId: 'c', messageId: '1' }))
    const d = {
      boxes: async () => ({ boxes: [mailbox], broken: [] }),
      triage: triage as never,
      send,
      now: () => NOON,
      tz: 'UTC',
    }
    pause()
    expect(await svc.tick(d)).toEqual({ sent: 0, held: 0, paused: 0, triaged: 0 })
    expect(triage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const seen = getDb().prepare('SELECT COUNT(*) AS n FROM email_alert_seen').get() as { n: number }
    expect(seen.n).toBe(0)

    // Allowance back: the same mail is still there to be triaged.
    clearAiLimit()
    const r = await svc.tick(d)
    expect(triage).toHaveBeenCalledTimes(1)
    expect(r.triaged).toBe(1)
  })
})

describe('replay CLI while paused', () => {
  it('answers without a model call', async () => {
    const { main } = await import('../src/email-alerts/cli.js')
    pause()
    expect(await main(['replay', '3'])).toBe(
      "The assistant's AI allowance for this month is used up, so a replay can't run now."
    )
    expect(runtimeSpy).not.toHaveBeenCalled()
  })
})

describe('dreaming while paused', () => {
  it('resolves without calling the runtime', async () => {
    const { runDream } = await import('../src/dreaming/index.js')
    pause()
    await expect(runDream()).resolves.toBeUndefined()
    expect(runtimeSpy).not.toHaveBeenCalled()
  })
})

describe('selftest while paused', () => {
  it('reports the model check as skipped', async () => {
    const { defaultChecks } = await import('../src/selftest.js')
    const check = defaultChecks({ credentials: async () => ({ ok: true, detail: 'ok' }) as never, live: true }).find(
      (c) => c.name === 'live-model-call'
    )!
    pause()
    expect(await check.run()).toBe('skipped (AI allowance used up)')
    expect(runtimeSpy).not.toHaveBeenCalled()
  })
})
