/**
 * tests/claude-runtime-replay.test.ts
 *
 * A turn that dies on a transient API error is replayed, unless the failed
 * attempt already ran a tool that is not clearly read-only: replaying then
 * could send the email or create the event twice. query() is fully mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/** A turn that calls one tool, then dies on a transient API error before any text streams. */
function toolThenOverload(tool: string, sessionId = 'sess-side') {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: tool, input: {} }] } }
    throw new Error('API Error: 529 overloaded')
  })()
}

describe('ClaudeAgentRuntime transient-error retry vs side effects', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockReadEnvFile.mockReset()
    mockReadEnvFile.mockReturnValue({})
    mockGetSecret.mockReset()
    mockGetSecret.mockReturnValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not replay a turn that already ran a tool that is not read-only', async () => {
    mockQuery.mockReturnValueOnce(toolThenOverload('Bash')).mockReturnValueOnce(fakeConversation('should never run'))
    const runtime = new ClaudeAgentRuntime()

    const result = await runtime.run({ message: 'send the email', workingDirectory: '/tmp' })

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(result.text).toContain('Bash')
    expect(result.text).toContain('nothing runs twice')
    // The scheduler defers and re-runs a whole task when it sees these words; this must not trigger that.
    expect(result.text).not.toMatch(/\b(429|529|rate.?limit|overloaded)\b/i)
  })

  it('still retries when the failed attempt only read things', async () => {
    vi.useFakeTimers()
    mockQuery.mockReturnValueOnce(toolThenOverload('Read')).mockReturnValueOnce(fakeConversation('all good'))
    const runtime = new ClaudeAgentRuntime()

    const pending = runtime.run({ message: 'look something up', workingDirectory: '/tmp' })
    await vi.advanceTimersByTimeAsync(6000)
    const result = await pending

    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('all good')
  })
})
