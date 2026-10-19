/**
 * tests/runtime-isolated-turn.test.ts
 *
 * Per-turn model override and isolated (tool-less) turns, for both runtimes.
 *
 * Why isolated exists: email triage hands untrusted mail text (sender,
 * subject, body excerpt) to a cheap model for a yes/no verdict. An email can
 * carry prompt-injection text, so that turn must have no way to act: no
 * built-in tools, no MCP servers (project, user-level, or claude.ai
 * connectors), no settings sources (no CLAUDE.md, no user settings, no
 * plugins or skills pulled in through them), no session resume or
 * persistence, and a single turn. Only its text output is used.
 *
 * SDK option facts this file locks in (checked against the installed
 * @anthropic-ai/claude-agent-sdk, see the report for task 3):
 *   - `tools: []` is what disables every built-in tool (`--tools ""`).
 *     `allowedTools: []` emits no CLI flag at all; it only lists tools that
 *     skip the permission prompt, so on its own it disables nothing.
 *   - `mcpServers: {}` emits no flag either; `strictMcpConfig: true` is what
 *     makes the CLI ignore every MCP config it was not handed.
 *
 * query() is fully mocked; nothing spawns a subprocess or touches the network.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockReadEnvFile } = vi.hoisted(() => {
  const mockQuery = vi.fn()
  const mockReadEnvFile = vi.fn((): Record<string, string> => ({}))
  return { mockQuery, mockReadEnvFile }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))
vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  readEnvFile: mockReadEnvFile,
}))

import { ClaudeAgentRuntime } from '../src/runtime/claude.js'
import { SessionStore } from '../src/runtime/ai-sdk/sessions.js'
import { modelIdForTier } from '../src/runtime/ai-sdk/provider.js'

function fakeConversation(result: string, sessionId = 'sess-test') {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'result', subtype: 'success', result }
  })()
}

function queryOptions(i: number): any {
  return mockQuery.mock.calls[i][0].options
}

beforeEach(() => {
  mockQuery.mockReset()
  mockReadEnvFile.mockReset()
  mockReadEnvFile.mockReturnValue({})
  delete process.env.AGENT_MODEL
  mockQuery.mockImplementation(() => fakeConversation('ok'))
})

afterEach(() => {
  delete process.env.AGENT_MODEL
})

describe('claude runtime: per-turn model', () => {
  it('model option overrides AGENT_MODEL for one turn', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'sonnet' })
    const runtime = new ClaudeAgentRuntime()
    await runtime.run({ message: 'triage this', model: 'haiku' })
    await runtime.run({ message: 'normal turn' })
    expect(queryOptions(0).model).toBe('haiku')
    expect(queryOptions(1).model).toBe('sonnet')
  })

  it('runOnce honors a model override too', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'sonnet' })
    const runtime = new ClaudeAgentRuntime()
    await runtime.runOnce('a', { model: 'haiku' })
    await runtime.runOnce('b')
    expect(queryOptions(0).model).toBe('haiku')
    expect(queryOptions(1).model).toBe('sonnet')
  })
})

describe('claude runtime: isolated turns', () => {
  it('runs triage with tools disabled', async () => {
    const runtime = new ClaudeAgentRuntime()
    const result = await runtime.run({ message: 'triage this', isolated: true, sessionId: 'old-session', model: 'haiku' })
    expect(result.text).toBe('ok')

    const o = queryOptions(0)
    // Zero built-in tools: `tools: []` is the switch; allowedTools: [] alone is a no-op.
    expect(o.tools).toEqual([])
    expect(o.allowedTools).toEqual([])
    // No MCP servers, and strict mode so user-level / connector configs are ignored.
    expect(o.mcpServers).toEqual({})
    expect(o.strictMcpConfig).toBe(true)
    // No CLAUDE.md, no user/project settings (and so no plugins, hooks or skills from them).
    expect(o.settingSources).toEqual([])
    expect(o.maxTurns).toBe(1)
    expect(o).not.toHaveProperty('resume')
    expect(o.persistSession).toBe(false)
    // Nothing is auto-approved: anything that slipped through would be refused, not run.
    expect(o.permissionMode).not.toBe('bypassPermissions')
    expect(o.permissionMode).toBe('dontAsk')
    // No tools, so no guard hook to run; and no agents roster.
    expect(o.hooks).toBeUndefined()
    expect(o.agents).toBeUndefined()
    expect(o.model).toBe('haiku')
  })

  it('an isolated turn ignores a scope (it offers no tools at all)', async () => {
    const runtime = new ClaudeAgentRuntime()
    await runtime.run({ message: 'x', isolated: true, scope: { role: 'research' } })
    const o = queryOptions(0)
    expect(o.tools).toEqual([])
    expect(o.mcpServers).toEqual({})
  })

  it('an isolated turn never resumes, even on the overflow lane', async () => {
    mockReadEnvFile.mockReturnValue({ ANTHROPIC_API_KEY: 'sk-test' })
    let call = 0
    mockQuery.mockImplementation(() => {
      call++
      if (call === 1) {
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'sub-sess' }
          yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }
        })()
      }
      return fakeConversation('ok', 'api-sess')
    })
    const runtime = new ClaudeAgentRuntime()
    await runtime.run({ message: 'x', isolated: true, sessionId: 'old' })
    expect(mockQuery.mock.calls.length).toBe(2)
    for (const i of [0, 1]) {
      expect(queryOptions(i)).not.toHaveProperty('resume')
      expect(queryOptions(i).tools).toEqual([])
    }
  })

  it('an isolated turn does not consume a queued chat steer', async () => {
    const runtime = new ClaudeAgentRuntime()
    runtime.steer('follow up for chat')
    await runtime.run({ message: 'triage', isolated: true })
    expect(mockQuery.mock.calls.length).toBe(1)
    // The steer is still pending for the next normal turn, which chains it.
    await runtime.run({ message: 'chat turn' })
    expect(mockQuery.mock.calls.length).toBe(3)
    expect(mockQuery.mock.calls[2][0].prompt).toBe('[steer]: follow up for chat')
  })

  it('non-isolated turns are unchanged', async () => {
    const runtime = new ClaudeAgentRuntime()
    await runtime.run({ message: 'hello', sessionId: 's1' })
    const o = queryOptions(0)
    expect(o.settingSources).toEqual(['project', 'user'])
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.resume).toBe('s1')
    expect(o.hooks?.PreToolUse).toHaveLength(1)
    expect(o).not.toHaveProperty('tools')
    expect(o).not.toHaveProperty('maxTurns')
    expect(o).not.toHaveProperty('persistSession')
  })
})

describe('ai-sdk runtime', () => {
  async function mockModel() {
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            { type: 'text-delta' as const, id: 't1', delta: 'NO: routine newsletter' },
            { type: 'text-end' as const, id: 't1' },
            { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
          ],
        }),
      }),
    })
  }

  function memStore() {
    const rows = new Map<string, string>()
    const db = {
      exec() {},
      prepare(sql: string) {
        if (/SELECT/i.test(sql)) return { get: (id: string) => (rows.has(id) ? { messages: rows.get(id)!, provider: null } : undefined) }
        return { run: (id: string, messages: string) => { rows.set(id, messages) } }
      },
    }
    return { store: new SessionStore(db as any), rows }
  }

  it('ai-sdk honors isolated', async () => {
    const model = await mockModel()
    const { store, rows } = memStore()
    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const runtime = new AiSdkAgentRuntime(store, model as any)
    const result = await runtime.run({ message: 'triage this', isolated: true, model: 'haiku' })
    expect(result.text).toBe('NO: routine newsletter')

    expect(model.doStreamCalls).toHaveLength(1)
    const call = model.doStreamCalls[0] as any
    // Called with no tools at all.
    expect(call.tools ?? []).toEqual([])
    // No project CLAUDE.md or environment block in the system prompt.
    const system = call.prompt.filter((m: any) => m.role === 'system').map((m: any) => String(m.content)).join('\n')
    expect(system).not.toMatch(/CLAUDE\.md|Working directory/i)
    // Only the triage message goes out, and nothing is persisted.
    expect(call.prompt.filter((m: any) => m.role === 'user')).toHaveLength(1)
    expect(rows.size).toBe(0)
  })

  it('ai-sdk non-isolated turns still offer tools', async () => {
    const model = await mockModel()
    const { store } = memStore()
    const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
    const runtime = new AiSdkAgentRuntime(store, model as any)
    await runtime.run({ message: 'hello' })
    const call = model.doStreamCalls[0] as any
    expect((call.tools ?? []).length).toBeGreaterThan(0)
  })
})

describe('ai-sdk model tiers', () => {
  it('sonnet and no tier map to the configured default', () => {
    expect(modelIdForTier('anthropic', 'claude-sonnet-5', undefined, () => undefined)).toBe('claude-sonnet-5')
    expect(modelIdForTier('anthropic', 'claude-sonnet-5', 'sonnet', () => undefined)).toBe('claude-sonnet-5')
  })

  it('haiku maps to AI_MODEL_CHEAP, opus to AI_MODEL_STRONG', () => {
    const read = (k: string) => ({ AI_MODEL_CHEAP: 'gpt-5-mini', AI_MODEL_STRONG: 'gpt-5-pro' } as Record<string, string>)[k]
    expect(modelIdForTier('openai', 'gpt-5', 'haiku', read)).toBe('gpt-5-mini')
    expect(modelIdForTier('openai', 'gpt-5', 'opus', read)).toBe('gpt-5-pro')
  })

  it('anthropic has a cheap default; other providers fall back to the default model', () => {
    expect(modelIdForTier('anthropic', 'claude-sonnet-5', 'haiku', () => undefined)).toBe('claude-haiku-4-5')
    expect(modelIdForTier('openai', 'gpt-5', 'haiku', () => undefined)).toBe('gpt-5')
    expect(modelIdForTier('openai', 'gpt-5', 'opus', () => undefined)).toBe('gpt-5')
  })

  it('a full model id is used as given', () => {
    expect(modelIdForTier('anthropic', 'claude-sonnet-5', 'claude-opus-4-8', () => undefined)).toBe('claude-opus-4-8')
  })
})
