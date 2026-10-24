/**
 * Card #230: authority checked at each effect. The live grant, role expiry,
 * the gate reading both, the scheduler's retry rereading its task, and the
 * runtime pieces (an overload hands back its session, a steer keeps its scope).
 * query() is mocked, so nothing spawns.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

const h = vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-grant-${process.pid}`
  return { mockQuery: vi.fn() }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: h.mockQuery }))

import * as db from '../src/db.js'
import { currentGrant, taskGrant, withGrant } from '../src/assurance/grant.js'
import { gateToolCall } from '../src/assurance/scope-gate.js'
import { checkRole, roleExpired, type RoleSpec } from '../src/assurance/roles.js'
import { cancelDeferredRetry, continuationPrompt } from '../src/scheduler.js'
import { ClaudeAgentRuntime } from '../src/runtime/claude.js'

beforeAll(() => db.initDatabase())
afterEach(() => {
  vi.useRealTimers()
  h.mockQuery.mockReset()
})
afterAll(() => {
  try { db.getDb().close() } catch { /* no handle */ }
  try { rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true }) } catch { /* tmp */ }
})

const call = (command: string, scope?: { role: string; taskId?: string }) => ({ session: 's', tool: 'Bash', input: { command }, cwd: '/tmp', scope })

describe('live grant', () => {
  it('none outside a scheduled run', () => {
    expect(currentGrant()).toBeNull()
  })

  it('reads the task as it is now: deleted, paused, active with its role', () => {
    let row: { status: string; role: string | null } | undefined = { status: 'active', role: 'briefing' }
    const check = taskGrant('t1', () => row)
    withGrant(check, () => {
      expect(currentGrant()).toEqual({ ok: true, role: 'briefing', taskId: 't1' })
      row = { status: 'paused', role: 'briefing' }
      expect(currentGrant()).toMatchObject({ ok: false, reason: expect.stringMatching(/paused/) })
      row = undefined
      expect(currentGrant()).toMatchObject({ ok: false, reason: expect.stringMatching(/deleted/) })
    })
  })

  it('a check that throws fails closed', () => {
    withGrant(() => { throw new Error('db gone') }, () => {
      expect(currentGrant()).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be checked.*db gone/) })
    })
  })
})

describe('the gate reads the grant on every call', () => {
  it('a paused task refuses the next call, whatever the role', () => {
    withGrant(() => ({ ok: false, reason: 'the owner paused this scheduled task' }), () => {
      const v = gateToolCall(call('ls'))
      expect(v.allow).toBe(false)
      expect(!v.allow && v.reason).toMatch(/paused this scheduled task.*Stop here/)
    })
  })

  it('checks the role the task has now, not the one the run started with', () => {
    withGrant(() => ({ ok: true, role: 'briefing', taskId: 't2' }), () => {
      const v = gateToolCall(call('crm-cli.js update northpine status', { role: 'full', taskId: 't2' }))
      expect(v.allow).toBe(false)
      expect(!v.allow && v.reason).toMatch(/briefing role/)
      expect(gateToolCall(call('ls', { role: 'full', taskId: 't2' })).allow).toBe(true)
    })
  })

  it('a role cleared mid-run means every tool, as in chat', () => {
    withGrant(() => ({ ok: true, role: null, taskId: 't3' }), () => {
      expect(gateToolCall(call('crm-cli.js update northpine status', { role: 'briefing', taskId: 't3' })).allow).toBe(true)
    })
  })
})

describe('role expiry', () => {
  const role = (expiresAt?: string): RoleSpec => ({ id: 'temp', summary: 't', tools: ['*'], ...(expiresAt ? { expiresAt } : {}) })

  it('no expiry, a future one, a past one, and one that is not a date', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    expect(roleExpired(role(), now)).toBeNull()
    expect(roleExpired(role('2026-12-31'), now)).toBeNull()
    expect(roleExpired(role('2026-10-24T11:59:59Z'), now)).toMatch(/expired on 2026-10-24T11:59:59Z/)
    expect(roleExpired(role('next tuesday'), now)).toMatch(/not a date/)
  })

  it('an expired role refuses every call, even one with every tool', () => {
    const roles = new Map([['temp', role('2026-01-01')]])
    expect(checkRole(roles, 'temp', { tool: 'Read', input: {}, cwd: '/tmp' })).toMatchObject({ ok: false, kind: 'unauthorized', reason: expect.stringMatching(/expired/) })
  })

})

describe('scheduler retry', () => {
  it('continues the job instead of restating it bare', () => {
    const p = continuationPrompt('Run the Northpine follow-up')
    expect(p.startsWith('[retry]')).toBe(true)
    expect(p).toMatch(/finish only what is left/)
    expect(p.endsWith('Run the Northpine follow-up')).toBe(true)
  })

  it('cancelDeferredRetry is a no-op without a pending retry', () => {
    expect(cancelDeferredRetry('nothing-pending')).toBe(false)
  })
})

describe('claude runtime', () => {
  function conversation(sessionId: string, result?: string, error?: string) {
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sessionId }
      if (error) throw new Error(error)
      yield { type: 'result', subtype: 'success', is_error: false, result }
    })()
  }

  it('an overload that outlives the retries hands back the last session, so the retry can resume it', async () => {
    vi.useFakeTimers()
    for (let i = 0; i < 4; i++) h.mockQuery.mockReturnValueOnce(conversation(`sess-${i}`, undefined, 'API Error: 529 overloaded'))
    const pending = new ClaudeAgentRuntime().run({ message: 'job' })
    await vi.runAllTimersAsync()
    const out = await pending
    expect(out.text).toMatch(/temporarily overloaded/)
    expect(out.newSessionId).toBe('sess-3')
  })

  it('a steer queued during a scoped job runs inside the same role', async () => {
    const rt = new ClaudeAgentRuntime()
    h.mockQuery.mockImplementationOnce(() => { rt.steer('also do this'); return conversation('sess-a', 'first') })
    h.mockQuery.mockReturnValueOnce(conversation('sess-b', 'steered'))
    const out = await rt.run({ message: 'job', scope: { role: 'briefing', taskId: 't9' } })
    expect(out.text).toBe('steered')
    const [first, second] = h.mockQuery.mock.calls.map((c) => (c[0] as { options: { tools?: string[] } }).options)
    expect(first.tools).toBeDefined()
    expect(second.tools).toEqual(first.tools)
  })
})
