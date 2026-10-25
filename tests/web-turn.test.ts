/**
 * Web UI turns ride the bot's turn queue with their own session, model and
 * effort, and never touch the chat's `sessions` row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'web-turn-'))
  process.env['AGENT_STORE_DIR'] = store
  return { store: store as string, saveTurn: vi.fn() }
})

vi.mock('../src/memory.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  saveConversationTurn: h.saveTurn,
}))

import { runWebTurn, cancelWebTurn, turnsIdle } from '../src/bot.js'
import { getSession, setSession, initDatabase } from '../src/db.js'
import { setAgentRuntime } from '../src/runtime/index.js'
import { readAiLimit, writeAiLimit, clearAiLimit, FIRST_REPLY, REPEAT_REPLY } from '../src/ai-limit.js'
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../src/runtime/types.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  calls: AgentRunOptions[] = []
  result: AgentRunResult = { text: 'web reply', newSessionId: 'web-sess-2' }
  gate: Promise<void> | null = null
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options)
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<void>((r) => options.signal?.addEventListener('abort', () => r(), { once: true })),
      ])
    }
    return this.result
  }
  async runOnce(): Promise<string> { return 'once' }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> { return new Map() }
}

let rt: FakeRuntime

beforeEach(() => {
  initDatabase()
  h.saveTurn.mockReset()
  rt = new FakeRuntime()
  setAgentRuntime(rt)
})

afterEach(async () => {
  setAgentRuntime(null)
  await turnsIdle()
})

describe('runWebTurn', () => {
  it('passes model, effort and session id through and returns the new session id', async () => {
    const res = await runWebTurn({
      chatId: 'owner', conversationId: 'c1', text: 'hello', framing: 'Project: Alpha',
      sessionId: 'web-sess-1', model: 'opus', effort: 'high',
    })
    expect(res).toEqual({ text: 'web reply', newSessionId: 'web-sess-2', cancelled: false })
    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]!.model).toBe('opus')
    expect(rt.calls[0]!.effort).toBe('high')
    expect(rt.calls[0]!.sessionId).toBe('web-sess-1')
    const msg = rt.calls[0]!.message
    expect(msg.indexOf('Project: Alpha')).toBeGreaterThanOrEqual(0)
    expect(msg.indexOf('Project: Alpha')).toBeLessThan(msg.lastIndexOf('hello'))
    expect(h.saveTurn).toHaveBeenCalledWith('owner', 'hello', 'web reply')
  })

  it('reports onQueued(1) for a turn queued behind a running one', async () => {
    let release!: () => void
    rt.gate = new Promise<void>((r) => { release = r })
    const first = runWebTurn({ chatId: 'owner', conversationId: 'a', text: 'one' })
    const aheadSeen: number[] = []
    const second = runWebTurn({ chatId: 'owner', conversationId: 'b', text: 'two', onQueued: (n) => aheadSeen.push(n) })
    expect(aheadSeen).toEqual([1])
    release()
    await Promise.all([first, second])
  })

  it('cancelWebTurn while running gives cancelled and saves no memory', async () => {
    rt.gate = new Promise<void>(() => {})
    const p = runWebTurn({ chatId: 'owner', conversationId: 'c2', text: 'long one' })
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1))
    const r = cancelWebTurn('c2')
    expect(r.stoppedActive).toBe(true)
    const res = await p
    expect(res.cancelled).toBe(true)
    expect(res.text).toBeNull()
    expect(h.saveTurn).not.toHaveBeenCalled()
  })

  it('a queued turn dropped by cancelWebTurn resolves cancelled', async () => {
    let release!: () => void
    rt.gate = new Promise<void>((r) => { release = r })
    const first = runWebTurn({ chatId: 'owner', conversationId: 'x', text: 'one' })
    const second = runWebTurn({ chatId: 'owner', conversationId: 'y', text: 'two' })
    expect(cancelWebTurn('y').droppedQueued).toBe(1)
    release()
    expect((await second)).toEqual({ text: null, cancelled: true })
    await first
  })

  it('leaves the chat session row unchanged', async () => {
    setSession('owner', 'telegram-sess')
    await runWebTurn({ chatId: 'owner', conversationId: 'c3', text: 'hi', sessionId: 'web-sess-1' })
    expect(getSession('owner')).toBe('telegram-sess')
  })

  it('always says why a paused turn has no reply, with or without a fresh marker', async () => {
    rt.result = { text: null, aiPaused: 'spend_limit' }
    const res = await runWebTurn({ chatId: 'owner', conversationId: 'p1', text: 'are you there' })
    expect(res.cancelled).toBe(false)
    expect(res.text).toBeNull()
    expect(res.paused).toMatch(/paused/i)
    expect(h.saveTurn).not.toHaveBeenCalled()
  })

  it("a web pause shows the first-notice text without using up Telegram's once-a-day notice", async () => {
    rt.result = { text: null, aiPaused: 'spend_limit' }
    const marker = { kind: 'spend_limit' as const, since: new Date().toISOString() }
    writeAiLimit(marker)
    const res = await runWebTurn({ chatId: 'owner', conversationId: 'p2', text: 'hello?' })
    expect(res.paused).toBe(FIRST_REPLY)
    expect(readAiLimit()).toEqual(marker)

    // Inside the repeat window the web still says why, with the repeat text.
    const told = { ...marker, lastToldAt: new Date().toISOString(), toldFull: true }
    writeAiLimit(told)
    const again = await runWebTurn({ chatId: 'owner', conversationId: 'p3', text: 'still?' })
    expect(again.paused).toBe(REPEAT_REPLY)
    expect(readAiLimit()).toEqual(told)
    clearAiLimit()
  })
})
