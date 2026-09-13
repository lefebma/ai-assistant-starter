/**
 * tests/ai-sdk-cancel.test.ts
 *
 * AgentRunOptions.signal on the provider-agnostic runtime: same contract as
 * the claude runtime (tests/claude-runtime-cancel.test.ts). On abort, stop,
 * skip retries, and resolve text: null. Harness mirrors ai-sdk-subagent.test.ts
 * with stream() made overridable.
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

beforeAll(async () => {
  ;({ AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js'))
  ;({ SessionStore } = await import('../src/runtime/ai-sdk/sessions.js'))
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

describe('AiSdkAgentRuntime cancellation (AbortSignal)', () => {
  it('should resolve text: null without ever constructing a ToolLoopAgent when the signal is already aborted', async () => {
    const runtime = freshRuntime()
    const controller = new AbortController()
    controller.abort()

    const result = await runtime.run({ message: 'hi', signal: controller.signal })

    expect(result.text).toBeNull()
    expect(captured).toHaveLength(0)
    expect(capturedStreamArgs).toHaveLength(0)
  })

  it('should resolve text: null and not retry when the caller aborts mid-stream, discarding any streamed partial text', async () => {
    const callerController = new AbortController()
    streamImpl = () =>
      Promise.resolve({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'partial answer' }
          // Simulates the user talking over the reply: the bridge aborts the
          // caller-level signal mid-turn.
          callerController.abort()
          yield { type: 'text-delta', text: ' more that should never ship' }
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'partial answer more that should never ship' }] }),
        text: Promise.resolve('partial answer more that should never ship'),
      })
    const runtime = freshRuntime()

    const result = await runtime.run({ message: 'hi', signal: callerController.signal })

    expect(result.text).toBeNull()
    // Exactly one stream() call: aborting mid-turn must not trigger a retry.
    expect(capturedStreamArgs).toHaveLength(1)
  })

  it('should link the caller signal to a fresh internal AbortController passed as `abortSignal` in stream() options', async () => {
    const callerController = new AbortController()
    let observedSignal: AbortSignal | undefined
    streamImpl = (args) => {
      observedSignal = (args as { abortSignal: AbortSignal }).abortSignal
      return Promise.resolve({
        fullStream: (async function* () {})(),
        response: Promise.resolve({ messages: [] }),
        text: Promise.resolve('reply'),
      })
    }
    const runtime = freshRuntime()

    await runtime.run({ message: 'hi', signal: callerController.signal })

    expect(observedSignal).toBeInstanceOf(AbortSignal)
    // Not the same object as the caller's own signal: a per-attempt controller,
    // merely linked to it.
    expect(observedSignal).not.toBe(callerController.signal)
    expect(observedSignal?.aborted).toBe(false)
  })

  it('should abort the internal stream() AbortSignal when the caller signal aborts', async () => {
    const callerController = new AbortController()
    let observedSignal: AbortSignal | undefined
    streamImpl = (args) => {
      observedSignal = (args as { abortSignal: AbortSignal }).abortSignal
      callerController.abort()
      return Promise.resolve({
        fullStream: (async function* () {})(),
        response: Promise.resolve({ messages: [] }),
        text: Promise.resolve('reply'),
      })
    }
    const runtime = freshRuntime()

    await runtime.run({ message: 'hi', signal: callerController.signal })

    expect(observedSignal?.aborted).toBe(true)
  })

  it('should resolve text: null (not throw or retry) when the stream throws after the caller aborts', async () => {
    const callerController = new AbortController()
    streamImpl = () => {
      callerController.abort()
      throw new Error('provider aborted mid-request')
    }
    const runtime = freshRuntime()

    const result = await runtime.run({ message: 'hi', signal: callerController.signal })

    expect(result.text).toBeNull()
    expect(capturedStreamArgs).toHaveLength(1)
  })
})
