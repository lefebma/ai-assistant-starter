/**
 * Task A4: background callers skip their model work while the AI allowance
 * marker is set (and no recovery probe is due), and behave as before otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
import { writeAiLimit, clearAiLimit, aiPausedForBackground, MANAGED_AI_FILE, readAiLimit } from '../src/ai-limit.js'
import { STORE_DIR } from '../src/config.js'

rmSync(STORE_DIR, { recursive: true, force: true })
// Background pause only applies on a managed box.
mkdirSync(STORE_DIR, { recursive: true })
writeFileSync(join(STORE_DIR, MANAGED_AI_FILE), '{}')

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

const DUE = (): string => new Date(Date.now() - 20 * 60_000).toISOString()

describe('aiPausedForBackground', () => {
  it('is false without a marker, true with one, due or not', () => {
    expect(aiPausedForBackground()).toBe(false)
    pause()
    expect(aiPausedForBackground()).toBe(true)
    pause({ since: DUE() })
    expect(aiPausedForBackground()).toBe(true)
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

  it('keeps a paused one-shot for the recovery time, then runs and deletes it', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const due = nowS - 60
    createTask('paused-once', '123', 'once work', '0 9 1 1 *', due, 'Once', 'silent', 'America/Toronto', true)
    const since = new Date(Date.now() - 5 * 60_000).toISOString()
    pause({ since })
    await runDueTasks()
    expect(runAgentSpy).not.toHaveBeenCalled()
    const row = getDb().prepare('SELECT next_run, last_result, last_run FROM scheduled_tasks WHERE id = ?').get('paused-once') as {
      next_run: number
      last_result: string | null
      last_run: number | null
    }
    // since + 15 min = about 10 minutes from now, nowhere near next year.
    const expected = Math.ceil((Date.parse(since) + 15 * 60_000) / 1000)
    expect(row.next_run).toBe(expected)
    expect(row.next_run - nowS).toBeLessThan(15 * 60)
    expect(row.last_result).toBeNull()
    expect(row.last_run).toBeNull()

    // Pause lifts and the task comes due: it runs once and is deleted.
    clearAiLimit()
    getDb().prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(nowS - 1, 'paused-once')
    await runDueTasks()
    expect(runAgentSpy).toHaveBeenCalledTimes(1)
    expect(getDb().prepare('SELECT 1 FROM scheduled_tasks WHERE id = ?').get('paused-once')).toBeUndefined()
  })

  it('a paused one-shot with a fresh marker retries in about 15 minutes', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    createTask('paused-once-2', '123', 'once work 2', '0 9 1 1 *', nowS - 60, 'Once2', 'silent', 'America/Toronto', true)
    // Marker set just now: recovery is due in about 15 minutes.
    pause()
    await runDueTasks()
    const row = getDb().prepare('SELECT next_run FROM scheduled_tasks WHERE id = ?').get('paused-once-2') as { next_run: number }
    expect(row.next_run - nowS).toBeGreaterThan(14 * 60)
    expect(row.next_run - nowS).toBeLessThanOrEqual(15 * 60 + 2)
  })

  it('a marker with recovery due still skips: the scheduler is never the probe', async () => {
    const sent: string[] = []
    initScheduler(async (_c: string, t: string) => void sent.push(t))
    const nowS = Math.floor(Date.now() / 1000)
    createTask('due-rec', '123', 'work', '0 9 * * *', nowS - 60, 'Due rec', 'announce')
    createTask('due-once', '123', 'once', '0 9 1 1 *', nowS - 60, 'Due once', 'announce', 'America/Toronto', true)
    pause({ since: DUE() })
    await runDueTasks()
    expect(runAgentSpy).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    const rec = getDb().prepare('SELECT last_result FROM scheduled_tasks WHERE id = ?').get('due-rec') as { last_result: string }
    expect(rec.last_result).toBe('SKIPPED: AI allowance used up')
    const once = getDb().prepare('SELECT next_run FROM scheduled_tasks WHERE id = ?').get('due-once') as { next_run: number }
    expect(once.next_run - nowS).toBeGreaterThan(14 * 60)
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id IN ('due-rec','due-once')").run()
  })

  it('a run that comes back aiPaused sends nothing, skips a recurring task and keeps a one-shot', async () => {
    const sent: string[] = []
    initScheduler(async (_c: string, t: string) => void sent.push(t))
    const nowS = Math.floor(Date.now() / 1000)
    createTask('mid-rec', '123', 'work', '0 9 * * *', nowS - 60, 'Mid rec', 'silent')
    createTask('mid-once', '123', 'once', '0 9 1 1 *', nowS - 60, 'Mid once', 'silent', 'America/Toronto', true)
    runAgentSpy.mockImplementation(async () => {
      if (!readAiLimit()) pause()
      return { text: null, aiPaused: 'spend_limit' } as never
    })
    try {
      await runDueTasks()
    } finally {
      runAgentSpy.mockImplementation(async () => ({ text: 'done' }))
    }
    expect(sent).toEqual([])
    expect(sent.some((t) => t.includes('(no response)'))).toBe(false)
    const rec = getDb().prepare('SELECT next_run, last_result FROM scheduled_tasks WHERE id = ?').get('mid-rec') as {
      next_run: number
      last_result: string
    }
    expect(rec.last_result).toBe('SKIPPED: AI allowance used up')
    expect(rec.next_run).toBeGreaterThan(nowS)
    const once = getDb().prepare('SELECT next_run FROM scheduled_tasks WHERE id = ?').get('mid-once') as { next_run: number } | undefined
    expect(once).toBeDefined()
    expect(once!.next_run - nowS).toBeGreaterThan(14 * 60)
    expect(once!.next_run - nowS).toBeLessThanOrEqual(15 * 60 + 2)
    getDb().prepare("DELETE FROM scheduled_tasks WHERE id IN ('mid-rec','mid-once')").run()
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

describe('email alerts and the recovery probe', () => {
  const NOON = new Date('2026-10-18T12:00:00Z')
  const mail = (id: string) => ({
    mailbox: 'a@x.com', msgId: id, rfcMessageId: `<${id}@x.com>`, receivedAt: NOON.getTime() - 1000,
    headers: { from: 'Person <p@client.com>' }, subject: `Mail ${id}`,
  })
  async function fresh() {
    const s = await import('../src/email-alerts/store.js')
    for (const t of ['email_alert_seen', 'email_alerts']) getDb().exec(`DELETE FROM ${t}`)
    s.saveSettings({
      enabled: true, pauseUntil: null, pauseIndefinite: false, pauseStartedAt: null,
      quietStart: '22:00', quietEnd: '07:00', seededMailboxes: ['a@x.com'], pauseSummaryPending: false,
    })
    const svc = await import('../src/email-alerts/service.js')
    const box = { id: 'a@x.com', provider: 'gmail' as const, list: async () => [mail('m1'), mail('m2'), mail('m3')], body: async () => 'b' }
    return { svc, box }
  }
  const seenIds = (): string[] =>
    (getDb().prepare("SELECT msg_id FROM email_alert_seen WHERE msg_id LIKE 'm%' ORDER BY msg_id").all() as { msg_id: string }[]).map((r) => r.msg_id)

  it('marker present and recovery due: no triage, nothing marked seen', async () => {
    const { svc, box } = await fresh()
    const triage = vi.fn(async () => ({ kind: 'verdict' as const, verdict: { critical: false, reason: '' } }))
    pause({ since: DUE() })
    const r = await svc.tick({ boxes: async () => ({ boxes: [box], broken: [] }), triage: triage as never, send: vi.fn() as never, now: () => NOON, tz: 'UTC' })
    expect(triage).not.toHaveBeenCalled()
    expect(r.triaged).toBe(0)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM email_alert_seen').get() as { n: number }).n).toBe(0)
  })

  it('a pause that begins on mail 1 of 3 (paused outcome) leaves mails 2 and 3 unseen', async () => {
    const { svc, box } = await fresh()
    const triage = vi.fn(async () => ({ kind: 'paused' as const }))
    await svc.tick({ boxes: async () => ({ boxes: [box], broken: [] }), triage: triage as never, send: vi.fn() as never, now: () => NOON, tz: 'UTC' })
    expect(triage).toHaveBeenCalledTimes(1)
    expect(seenIds()).toEqual(['m1'])
  })

  it('a pause that begins on mail 1 of 3 (marker written) leaves mails 2 and 3 unseen', async () => {
    const { svc, box } = await fresh()
    const triage = vi.fn(async () => {
      pause()
      return { kind: 'failed' as const }
    })
    await svc.tick({ boxes: async () => ({ boxes: [box], broken: [] }), triage: triage as never, send: vi.fn() as never, now: () => NOON, tz: 'UTC' })
    expect(triage).toHaveBeenCalledTimes(1)
    expect(seenIds()).toEqual(['m1'])
  })
})

describe('email alerts model-free delivery while paused', () => {
  it('delivers a stored retry row but reads no mailbox and marks nothing seen', async () => {
    const s = await import('../src/email-alerts/store.js')
    const svc = await import('../src/email-alerts/service.js')
    for (const t of ['email_alert_seen', 'email_alerts']) getDb().exec(`DELETE FROM ${t}`)
    s.saveSettings({
      enabled: true, pauseUntil: null, pauseIndefinite: false, pauseStartedAt: null,
      quietStart: '22:00', quietEnd: '07:00', seededMailboxes: ['a@x.com'], pauseSummaryPending: false,
    })
    s.insertAlert({
      mailbox: 'a@x.com', msgId: 'old1', sender: 'Boss <b@x.com>', subject: 'Down', reason: 'Site down',
      vip: false, status: 'retry', createdAt: 1,
    })
    const boxes = vi.fn(async () => ({ boxes: [], broken: [] }))
    const triage = vi.fn()
    const send = vi.fn(async () => ({ chatId: 'c', messageId: '9' }))
    pause()
    const r = await svc.tick({
      boxes, triage: triage as never, send, now: () => new Date('2026-10-18T12:00:00Z'), tz: 'UTC',
    })
    expect(r.sent).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(s.alertsByStatus('retry')).toHaveLength(0)
    expect(boxes).not.toHaveBeenCalled()
    expect(triage).not.toHaveBeenCalled()
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM email_alert_seen').get() as { n: number }).n).toBe(0)
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
