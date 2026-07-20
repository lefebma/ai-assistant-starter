/**
 * tests/ai-sdk-subagent.test.ts
 * Offline coverage for AiSdkAgentRuntime's tool wiring (Phase 2, second
 * slice): dispatch_subagent depth guard and MCP tool progress-wrapping.
 *
 * ToolLoopAgent (from 'ai') is mocked so this exercises the runtime's own
 * wiring logic (buildAgent / buildSubagentTool / withProgress) without
 * needing to fabricate a full LanguageModelV3 tool-calling protocol, and
 * loadMcpTools is mocked so no real MCP server is ever touched. Each test
 * file gets its own module registry in vitest, so these mocks don't leak
 * into tests/ai-sdk-runtime.test.ts or tests/ai-sdk-mcp.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedAgent = {
  tools: Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>
}

let captured: CapturedAgent[] = []

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    ToolLoopAgent: vi.fn().mockImplementation((opts: CapturedAgent) => {
      captured.push(opts)
      return {
        generate: vi.fn(async () => ({ text: 'stub-subagent-report' })),
        stream: vi.fn(async () => ({
          fullStream: (async function* () {})(),
          response: Promise.resolve({ messages: [] }),
          text: Promise.resolve('stub-top-level-reply'),
        })),
      }
    }),
  }
})

const fakeMcpExecute = vi.fn(async () => 'mcp-tool-result')
vi.mock('../src/runtime/ai-sdk/mcp.js', () => ({
  loadMcpTools: vi.fn(async () => ({
    mcp__fake__ping: { description: 'fake', execute: fakeMcpExecute },
  })),
}))

class FakeDb {
  private rows = new Map<string, string>()
  exec(_sql: string): void {}
  prepare(sql: string) {
    if (/SELECT/i.test(sql)) {
      return { get: (id: string) => (this.rows.has(id) ? { messages: this.rows.get(id)! } : undefined) }
    }
    return {
      run: (id: string, messages: string, _updatedAt: number) => {
        this.rows.set(id, messages)
      },
    }
  }
}

async function freshRuntime() {
  const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
  const { SessionStore } = await import('../src/runtime/ai-sdk/sessions.js')
  return new AiSdkAgentRuntime(new SessionStore(new FakeDb() as any), {} as any)
}

beforeEach(() => {
  captured = []
  fakeMcpExecute.mockClear()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('AiSdkAgentRuntime tool wiring', () => {
  it('gives the top-level turn dispatch_subagent and the progress-wrapped MCP tools', async () => {
    const runtime = await freshRuntime()
    const progress: Array<[string, string]> = []

    await runtime.run({ message: 'hi', onToolProgress: (name, status) => progress.push([name, status]) })

    expect(captured).toHaveLength(1)
    const topTools = captured[0].tools
    expect(topTools).toHaveProperty('dispatch_subagent')
    expect(topTools).toHaveProperty('mcp__fake__ping')

    // The MCP tool is wrapped: invoking it fires onToolProgress once, then
    // delegates to the real (mocked) execute exactly once.
    const result = await topTools.mcp__fake__ping.execute!({ x: 1 }, {})
    expect(result).toBe('mcp-tool-result')
    expect(fakeMcpExecute).toHaveBeenCalledTimes(1)
    expect(progress).toEqual([['mcp__fake__ping', JSON.stringify({ x: 1 })]])
  })

  it('does not expose dispatch_subagent to a dispatched subagent (depth guard)', async () => {
    const runtime = await freshRuntime()
    await runtime.run({ message: 'hi' })

    expect(captured).toHaveLength(1)
    const dispatch = captured[0].tools.dispatch_subagent
    expect(dispatch?.execute).toBeTypeOf('function')

    const report = await dispatch!.execute!({ prompt: 'do a self-contained thing' }, {})

    // buildSubagentTool called this.buildAgent(..., { subagents: false }),
    // which is a second ToolLoopAgent construction -- capture it and confirm
    // it has no path back to dispatch_subagent (no nesting possible).
    expect(captured).toHaveLength(2)
    const subTools = captured[1].tools
    expect(subTools).not.toHaveProperty('dispatch_subagent')
    expect(subTools).toHaveProperty('mcp__fake__ping') // parity: subagent keeps the same base tools
    expect(report).toBe('stub-subagent-report')
  })

  it('does not double-invoke or double-wrap the MCP tool between the top-level and subagent tool sets', async () => {
    const runtime = await freshRuntime()
    await runtime.run({ message: 'hi' })
    await captured[0].tools.dispatch_subagent!.execute!({ prompt: 'go' }, {})
    expect(captured).toHaveLength(2)

    fakeMcpExecute.mockClear()
    await captured[0].tools.mcp__fake__ping.execute!({}, {})
    expect(fakeMcpExecute).toHaveBeenCalledTimes(1)

    fakeMcpExecute.mockClear()
    await captured[1].tools.mcp__fake__ping.execute!({}, {})
    expect(fakeMcpExecute).toHaveBeenCalledTimes(1)
  })

  it('loads MCP tools once per runtime instance across multiple turns (memoization)', async () => {
    const { loadMcpTools } = await import('../src/runtime/ai-sdk/mcp.js')
    const runtime = await freshRuntime()

    await runtime.run({ message: 'first turn' })
    await runtime.run({ message: 'second turn' })
    await runtime.runOnce('third turn, one-shot')

    expect(loadMcpTools).toHaveBeenCalledTimes(1)
  })
})
