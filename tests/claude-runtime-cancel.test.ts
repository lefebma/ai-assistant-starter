/**
 * tests/claude-runtime-cancel.test.ts
 *
 * The cancellation contract live voice relies on: AgentRunOptions.signal stops
 * a Claude turn (the SDK's abortController kills the CLI), skips retries and
 * the ANTHROPIC_API_KEY overflow lane, and resolves text: null instead of
 * throwing. query() is fully mocked, so nothing spawns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockReadEnvFile, mockGetSecret } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
  mockGetSecret: vi.fn((_name: string): string | undefined => undefined),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))
vi.mock('../src/env.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/env.js')>()), readEnvFile: mockReadEnvFile }))
vi.mock('../src/vault/index.js', () => ({ getSecret: mockGetSecret }))

import { ClaudeAgentRuntime } from '../src/runtime/claude.js'

function fakeConversation(result: string, sessionId = 'sess-test') {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'result', subtype: 'success', result }
  })()
}

function lastQueryOptions(): any {
  const calls = mockQuery.mock.calls
  return calls[calls.length - 1]?.[0]?.options
}

describe('ClaudeAgentRuntime cancellation (AbortSignal)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadEnvFile.mockReset()
    mockReadEnvFile.mockReturnValue({})
    mockGetSecret.mockReset()
    mockGetSecret.mockReturnValue(undefined)
  })


  it('should resolve text: null without ever calling query() when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = new ClaudeAgentRuntime()

    const result = await runtime.run({ message: 'hello', signal: controller.signal })

    expect(result.text).toBeNull()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('should resolve text: null, skip retries, and skip the overflow lane when aborted mid-stream even though ANTHROPIC_API_KEY is resolvable', async () => {
    const controller = new AbortController()
    // Rejected subscription window (would normally escalate to the overflow
    // lane) but the abort happens before the post-loop escalation check runs.
    const conversation = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-mid-abort' }
      controller.abort()
      yield {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'usage_limit', resetsAt: 999 },
      }
      // No 'result' event -- the window is exhausted before a turn completes.
    })()
    mockQuery.mockReturnValue(conversation)
    // An overflow key IS resolvable -- the point of this test is that it must
    // never be used once the caller has cancelled the turn.
    mockGetSecret.mockImplementation((name: string) => (name === 'ANTHROPIC_API_KEY' ? 'fake-overflow-key' : undefined))
    const runtime = new ClaudeAgentRuntime()

    const result = await runtime.run({ message: 'hello', signal: controller.signal })

    expect(result.text).toBeNull()
    // Exactly the one (primary-lane) query() call: no retry, no overflow escalation.
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('should resolve text: null (not throw) when the underlying subprocess throws after abort', async () => {
    const controller = new AbortController()
    mockQuery.mockImplementation(() => {
      controller.abort()
      // eslint-disable-next-line @typescript-eslint/require-await
      return (async function* () {
        throw new Error('subprocess killed by AbortController')
      })()
    })
    const runtime = new ClaudeAgentRuntime()

    const result = await runtime.run({ message: 'hello', signal: controller.signal })

    expect(result.text).toBeNull()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('should pass a per-attempt AbortController as `abortController` in the query() options', async () => {
    mockQuery.mockReturnValue(fakeConversation('ok'))
    const controller = new AbortController()
    const runtime = new ClaudeAgentRuntime()

    await runtime.run({ message: 'hello', signal: controller.signal })

    const options = lastQueryOptions()
    expect(options.abortController).toBeInstanceOf(AbortController)
  })

  it('should not abort the query() abortController when the caller never aborts', async () => {
    mockQuery.mockReturnValue(fakeConversation('ok'))
    const controller = new AbortController()
    const runtime = new ClaudeAgentRuntime()

    await runtime.run({ message: 'hello', signal: controller.signal })

    expect(lastQueryOptions().abortController.signal.aborted).toBe(false)
  })

  it('should abort the query() abortController when the caller signal aborts', async () => {
    const controller = new AbortController()
    let capturedAbortController: AbortController | undefined
    mockQuery.mockImplementation((opts: any) => {
      capturedAbortController = opts.options.abortController
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-link' }
        controller.abort()
        yield { type: 'result', subtype: 'success', result: 'ignored' }
      })()
    })
    const runtime = new ClaudeAgentRuntime()

    await runtime.run({ message: 'hello', signal: controller.signal })

    expect(capturedAbortController?.signal.aborted).toBe(true)
  })
})

