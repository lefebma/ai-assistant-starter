/**
 * tests/ai-sdk-turn-end-log.test.ts
 *
 * Card #279: every ai-sdk turn ends with one "AI SDK agent turn ended" line in
 * service.log (outcome, reply length, duration, steps, tool calls, provider,
 * model), never the reply text. Harness copied from ai-sdk-cancel.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Windows CI collects this suite in ~60s on a cold filesystem. The default 5s
// testTimeout is charged against the test body, and the body used to include a
// dynamic import() of the runtime, so on a slow runner the first test aborted
// mid-flight. That is not a harmless flake: `captured` is written by the mocked
// ToolLoopAgent constructor at module scope, so the abandoned test's in-flight
// promise resolved during the NEXT test and pushed into its freshly reset
// array. The visible failure was "depth guard: expected 1, got 2" -- an
// assertion about code that was working fine, three lines away from the real
// cause. A global mock cannot be isolated from an abandoned async test, so the
// fix is to not abandon it: the import is hoisted to beforeAll below, and the
// budget is raised for headroom.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

type CapturedAgent = {
  tools: Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>
}

let captured: CapturedAgent[] = []
type StreamArgs = { messages: unknown; abortSignal: AbortSignal }
let capturedStreamArgs: StreamArgs[] = []

/** Default stream(): no tool calls, immediate stub reply. Tests override via streamImpl. */
function defaultStreamImpl(_args?: StreamArgs): Promise<{ fullStream: AsyncGenerator<unknown>; response: Promise<{ messages: unknown[] }>; text: Promise<string> }> {
  return Promise.resolve({
    fullStream: (async function* () {})(),
    response: Promise.resolve({ messages: [] }),
    text: Promise.resolve('stub-top-level-reply'),
  })
}
let streamImpl: (args: StreamArgs) => ReturnType<typeof defaultStreamImpl> = defaultStreamImpl

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    ToolLoopAgent: vi.fn().mockImplementation((opts: CapturedAgent) => {
      captured.push(opts)
      return {
        generate: vi.fn(async () => ({ text: 'stub-subagent-report' })),
        stream: vi.fn(async (args: StreamArgs) => {
          capturedStreamArgs.push(args)
          return streamImpl(args)
        }),
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

// Imported once for the whole file rather than per test. These are the
// expensive part on a cold runner, and paying that cost inside the first test
// is what put it over the timeout.
let AiSdkAgentRuntime: typeof import('../src/runtime/ai-sdk/index.js')['AiSdkAgentRuntime']
let SessionStore: typeof import('../src/runtime/ai-sdk/sessions.js')['SessionStore']
let logger: typeof import('../src/logger.js')['logger']

beforeAll(async () => {
  ;({ AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js'))
  ;({ SessionStore } = await import('../src/runtime/ai-sdk/sessions.js'))
  ;({ logger } = await import('../src/logger.js'))
})

function freshRuntime() {
  return new AiSdkAgentRuntime(new SessionStore(new FakeDb() as any), {} as any)
}

beforeEach(() => {
  captured = []
  capturedStreamArgs = []
  streamImpl = defaultStreamImpl
  fakeMcpExecute.mockClear()
})
afterEach(() => {
  vi.clearAllMocks()
})


const MSG = 'AI SDK agent turn ended'

/** Every turn-end line written during the test, from either level. */
function endLines(): Array<{ level: 'info' | 'warn'; fields: Record<string, unknown> }> {
  const out: Array<{ level: 'info' | 'warn'; fields: Record<string, unknown> }> = []
  for (const level of ['info', 'warn'] as const) {
    for (const call of (logger[level] as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      if (call[1] === MSG) out.push({ level, fields: call[0] as Record<string, unknown> })
    }
  }
  return out
}

function stream(parts: unknown[], text: string) {
  return () =>
    Promise.resolve({
      fullStream: (async function* () {
        for (const p of parts) yield p
      })(),
      response: Promise.resolve({ messages: [{ role: 'assistant', content: text }] }),
      text: Promise.resolve(text),
    })
}

// Only the logger spies are restored: vi.restoreAllMocks() would also wipe
// the ToolLoopAgent mock implementation the harness depends on.
let spies: Array<{ mockRestore: () => void }> = []
beforeEach(() => {
  spies = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn')]
})
afterEach(() => {
  for (const s of spies) s.mockRestore()
})

describe('ai-sdk turn end log (card #279)', () => {
  it('logs one success line with reply length, steps, tool calls, model and duration, and never the reply text', async () => {
    const reply = 'the secret reply text'
    streamImpl = stream(
      [
        { type: 'start-step' },
        { type: 'tool-call', toolName: 'bash', input: { command: 'ls' } },
        { type: 'finish-step', usage: { inputTokens: 10 } },
        { type: 'start-step' },
        { type: 'text-delta', text: reply },
        { type: 'finish-step', usage: { inputTokens: 12 } },
      ],
      reply,
    )
    const result = await freshRuntime().run({ message: 'hi' })

    expect(result.text).toBe(reply)
    const lines = endLines()
    expect(lines).toHaveLength(1)
    const { level, fields } = lines[0]!
    expect(level).toBe('info')
    expect(fields).toMatchObject({
      kind: 'turn',
      outcome: 'success',
      replyLength: reply.length,
      steps: 2,
      toolCalls: 1,
      attempts: 1,
      provider: 'override',
      modelId: 'override',
    })
    expect(fields.reason).toBeUndefined()
    expect(typeof fields.durationMs).toBe('number')
    expect(typeof fields.sessionId).toBe('string')
    expect(JSON.stringify(fields)).not.toContain('secret reply')
  })

  it('logs one error line at warn when the model fails', async () => {
    streamImpl = () => {
      throw new Error('invalid model configuration')
    }
    const result = await freshRuntime().run({ message: 'hi' })

    expect(result.text).toMatch(/^Ran into an error/)
    const lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe('warn')
    expect(lines[0]!.fields).toMatchObject({ outcome: 'error', steps: 0, toolCalls: 0, attempts: 1 })
    expect(lines[0]!.fields.reason).toBeUndefined()
    expect(lines[0]!.fields.replyLength).toBeGreaterThan(0)
  })

  it('logs one cancelled line when the caller aborts mid-stream', async () => {
    const caller = new AbortController()
    streamImpl = () =>
      Promise.resolve({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'partial' }
          caller.abort()
          yield { type: 'text-delta', text: ' more' }
        })(),
        response: Promise.resolve({ messages: [] }),
        text: Promise.resolve('partial more'),
      })
    const result = await freshRuntime().run({ message: 'hi', signal: caller.signal })

    expect(result.text).toBeNull()
    const lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe('info')
    expect(lines[0]!.fields).toMatchObject({ outcome: 'cancelled', replyLength: 0 })
  })

  it('logs a cancelled line when the turn is cancelled before it starts', async () => {
    const caller = new AbortController()
    caller.abort()
    await freshRuntime().run({ message: 'hi', signal: caller.signal })

    const lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.fields).toMatchObject({ outcome: 'cancelled', attempts: 1, steps: 0 })
  })

  it('marks an isolated turn as isolated', async () => {
    streamImpl = stream([], 'ok')
    await freshRuntime().run({ message: 'hi', isolated: true })

    expect(endLines().map(l => l.fields.kind)).toEqual(['isolated'])
  })

  it('records an error with reason loop when the loop guard stops the turn', async () => {
    const call = { type: 'tool-call', toolName: 'bash', input: { command: 'same' } }
    streamImpl = stream(Array.from({ length: 10 }, () => call), '')
    await freshRuntime().run({ message: 'hi' })

    const lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.fields).toMatchObject({ outcome: 'error', reason: 'loop' })
  })

  it('logs a subagent line when dispatch_subagent finishes, and one when it fails', async () => {
    const runtime = freshRuntime()
    streamImpl = stream([], 'top')
    await runtime.run({ message: 'hi' })
    const top = captured.find(a => a.tools.dispatch_subagent)!
    ;(logger.info as unknown as ReturnType<typeof vi.fn>).mockClear()
    ;(logger.warn as unknown as ReturnType<typeof vi.fn>).mockClear()

    const report = await top.tools.dispatch_subagent!.execute!({ prompt: 'do it' }, { abortSignal: new AbortController().signal })
    expect(report).toBe('stub-subagent-report')
    let lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.fields).toMatchObject({ kind: 'subagent', outcome: 'success', replyLength: 'stub-subagent-report'.length })
    expect(JSON.stringify(lines[0]!.fields)).not.toContain('stub-subagent-report')

    // The next agent built is the subagent: make its generate() fail.
    const { ToolLoopAgent } = await import('ai')
    ;(ToolLoopAgent as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce((opts: CapturedAgent) => {
      captured.push(opts)
      return { generate: vi.fn(async () => { throw new Error('boom') }), stream: vi.fn() }
    })
    ;(logger.info as unknown as ReturnType<typeof vi.fn>).mockClear()
    ;(logger.warn as unknown as ReturnType<typeof vi.fn>).mockClear()
    const failed = await top.tools.dispatch_subagent!.execute!({ prompt: 'do it' }, { abortSignal: new AbortController().signal })
    expect(failed).toMatch(/^Subagent failed/)
    lines = endLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!).toMatchObject({ level: 'warn', fields: { kind: 'subagent', outcome: 'error' } })
  })
})
