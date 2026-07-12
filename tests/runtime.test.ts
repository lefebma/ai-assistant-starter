/**
 * tests/runtime.test.ts
 * Verifies the AgentRuntime seam (Phase 1 of the LLM-agnostic plan):
 * - factory selection and unknown-runtime error
 * - setAgentRuntime test seam
 * - agent.ts facade delegation (positional args -> AgentRunOptions)
 *
 * Uses a fake runtime via setAgentRuntime() so no Claude Agent SDK code
 * runs. ClaudeAgentRuntime.run()/runOnce() are intentionally not exercised
 * here; the runtime is a verbatim move of the previous agent.ts logic.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getAgentRuntime, setAgentRuntime } from '../src/runtime/index.js'
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../src/runtime/types.js'
import { runAgent, steerAgent } from '../src/agent.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  runCalls: AgentRunOptions[] = []
  onceCalls: string[] = []
  steerCalls: string[] = []
  nextResult: AgentRunResult = { text: 'fake reply', newSessionId: 'sess-1' }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.runCalls.push(options)
    return this.nextResult
  }

  async runOnce(prompt: string): Promise<string> {
    this.onceCalls.push(prompt)
    return 'once'
  }

  steer(message: string): void {
    this.steerCalls.push(message)
  }

  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return new Map()
  }
}

afterEach(() => {
  setAgentRuntime(null)
  delete process.env.AGENT_RUNTIME
})

describe('runtime factory', () => {
  it('defaults to the claude runtime', () => {
    const runtime = getAgentRuntime()
    expect(runtime.id).toBe('claude')
  })

  it('returns the same instance on repeated calls', () => {
    expect(getAgentRuntime()).toBe(getAgentRuntime())
  })

  it('throws on an unknown AGENT_RUNTIME id', () => {
    process.env.AGENT_RUNTIME = 'does-not-exist'
    expect(() => getAgentRuntime()).toThrow(/Unknown AGENT_RUNTIME 'does-not-exist'/)
    expect(() => getAgentRuntime()).toThrow(/claude/)
  })

  it('setAgentRuntime swaps the active runtime', () => {
    const fake = new FakeRuntime()
    setAgentRuntime(fake)
    expect(getAgentRuntime()).toBe(fake)
    setAgentRuntime(null)
    expect(getAgentRuntime().id).toBe('claude')
  })
})

describe('agent facade delegation', () => {
  it('maps positional runAgent args onto AgentRunOptions', async () => {
    const fake = new FakeRuntime()
    setAgentRuntime(fake)
    const onTyping = () => {}
    const onPartial = (_t: string) => {}
    const onToolProgress = (_n: string, _s: string) => {}

    const result = await runAgent('hello', 'sess-0', onTyping, onPartial, onToolProgress)

    expect(fake.runCalls).toHaveLength(1)
    expect(fake.runCalls[0].message).toBe('hello')
    expect(fake.runCalls[0].sessionId).toBe('sess-0')
    expect(fake.runCalls[0].onTyping).toBe(onTyping)
    expect(fake.runCalls[0].onPartial).toBe(onPartial)
    expect(fake.runCalls[0].onToolProgress).toBe(onToolProgress)
    expect(result).toEqual({ text: 'fake reply', newSessionId: 'sess-1' })
  })

  it('handles the minimal call shape (message only)', async () => {
    const fake = new FakeRuntime()
    setAgentRuntime(fake)

    const result = await runAgent('just a message')

    expect(fake.runCalls[0].message).toBe('just a message')
    expect(fake.runCalls[0].sessionId).toBeUndefined()
    expect(fake.runCalls[0].onTyping).toBeUndefined()
    expect(result.text).toBe('fake reply')
  })

  it('passes through a null-text result unchanged', async () => {
    const fake = new FakeRuntime()
    fake.nextResult = { text: null }
    setAgentRuntime(fake)

    const result = await runAgent('anything')
    expect(result.text).toBeNull()
    expect(result.newSessionId).toBeUndefined()
  })

  it('steerAgent delegates to the runtime', () => {
    const fake = new FakeRuntime()
    setAgentRuntime(fake)
    steerAgent('change of plans')
    expect(fake.steerCalls).toEqual(['change of plans'])
  })
})
