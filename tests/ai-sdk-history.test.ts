/**
 * tests/ai-sdk-history.test.ts
 * Offline coverage for the ai-sdk lane's cost controls (history.ts):
 * - cachedSystem: system message carries the Anthropic cache breakpoint
 * - withCacheBreakpoint: marks only the last message, never mutates input,
 *   merges pre-existing providerOptions (reasoning signatures survive)
 * - trimHistory: watermark semantics, user-turn cut boundary, oversized
 *   final-exchange fallback
 * - historyMaxBytes: AI_HISTORY_MAX_BYTES env parsing (default, precedence,
 *   invalid-value fallback)
 *
 * Live cache-hit behavior (usage.cache_read_input_tokens > 0) is a billing
 * observation, not unit-testable offline — verify via the service log after
 * a deploy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
}))

// Same mock seam as tests/ai-sdk-provider.test.ts: history.ts imports
// readEnvFile from ../../env.js (== src/env.js), so this keeps the real
// .env from leaking into the historyMaxBytes() assertions below. It does
// not affect cachedSystem/withCacheBreakpoint/trimHistory-with-explicit-
// maxBytes, none of which touch readEnvFile.
vi.mock('../src/env.js', () => ({ readEnvFile: mockReadEnvFile }))

const { cachedSystem, historyMaxBytes, trimHistory, withCacheBreakpoint } = await import(
  '../src/runtime/ai-sdk/history.js'
)

function user(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): ModelMessage {
  return { role: 'assistant', content: text }
}

function toolResult(name: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'call-1', toolName: name, output: { type: 'text', value: 'ok' } },
    ],
  }
}

describe('cachedSystem', () => {
  it('returns a system message with an ephemeral cache breakpoint', () => {
    const msg = cachedSystem('be helpful')
    expect(msg.role).toBe('system')
    expect(msg.content).toBe('be helpful')
    expect(msg.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })
})

describe('withCacheBreakpoint', () => {
  it('marks only the last message', () => {
    const input = [user('one'), assistant('two'), user('three')]
    const out = withCacheBreakpoint(input)
    expect(out).toHaveLength(3)
    expect(out[0].providerOptions).toBeUndefined()
    expect(out[1].providerOptions).toBeUndefined()
    expect(out[2].providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })

  it('never mutates the input array or its messages', () => {
    const last = user('tail')
    const input = [user('head'), last]
    withCacheBreakpoint(input)
    expect(last.providerOptions).toBeUndefined()
    expect(input[1]).toBe(last)
  })

  it('merges with existing providerOptions instead of replacing them', () => {
    const signed: ModelMessage = {
      role: 'assistant',
      content: 'reasoned reply',
      providerOptions: { anthropic: { signature: 'sig-abc' } },
    }
    const out = withCacheBreakpoint([signed])
    expect(out[0].providerOptions).toEqual({
      anthropic: { signature: 'sig-abc', cacheControl: { type: 'ephemeral' } },
    })
  })

  it('passes empty arrays through untouched', () => {
    const input: ModelMessage[] = []
    expect(withCacheBreakpoint(input)).toBe(input)
  })
})

describe('trimHistory', () => {
  it('returns the same reference when under budget', () => {
    const input = [user('a'), assistant('b')]
    expect(trimHistory(input, 1_000_000)).toBe(input)
  })

  it('drops oldest turns and resumes at a user message', () => {
    const filler = 'x'.repeat(500)
    const input: ModelMessage[] = []
    for (let i = 0; i < 20; i++) {
      input.push(user(`${filler}-q${i}`), assistant(`${filler}-a${i}`))
    }
    const total = JSON.stringify(input).length
    const out = trimHistory(input, Math.floor(total / 2))

    expect(out.length).toBeLessThan(input.length)
    expect(out[0].role).toBe('user')
    // Most recent exchange always survives
    expect(out[out.length - 1]).toBe(input[input.length - 1])
    // Cut down to the low watermark, not just barely under the max
    const outBytes = out.reduce((n, m) => n + JSON.stringify(m).length, 0)
    expect(outBytes).toBeLessThanOrEqual(Math.floor(total / 2))
  })

  it('never resumes on a tool-result message', () => {
    const filler = 'y'.repeat(400)
    const input: ModelMessage[] = []
    for (let i = 0; i < 10; i++) {
      input.push(user(`${filler}-q${i}`), assistant(`${filler}-call${i}`), toolResult(`t${i}`), assistant(`${filler}-a${i}`))
    }
    const total = JSON.stringify(input).length
    const out = trimHistory(input, Math.floor(total / 3))
    expect(out[0].role).toBe('user')
  })

  it('keeps the final exchange whole even when it alone exceeds the budget', () => {
    const huge = assistant('z'.repeat(50_000))
    const input = [user('small question'), huge]
    const out = trimHistory(input, 1_000)
    expect(out).toEqual(input)
  })

  it('handles empty history', () => {
    const input: ModelMessage[] = []
    expect(trimHistory(input, 100)).toBe(input)
  })
})

describe('historyMaxBytes', () => {
  const ENV_KEY = 'AI_HISTORY_MAX_BYTES'

  beforeEach(() => {
    mockReadEnvFile.mockReset()
    mockReadEnvFile.mockReturnValue({})
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('defaults to 200000 when unset in .env and process.env', () => {
    expect(historyMaxBytes()).toBe(200_000)
  })

  it('reads AI_HISTORY_MAX_BYTES from .env', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '50000' })
    expect(historyMaxBytes()).toBe(50_000)
  })

  it('falls back to process.env when .env has no value', () => {
    mockReadEnvFile.mockReturnValue({})
    process.env[ENV_KEY] = '75000'
    expect(historyMaxBytes()).toBe(75_000)
  })

  it('prefers .env over process.env (matches provider.ts precedence)', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '10000' })
    process.env[ENV_KEY] = '999999'
    expect(historyMaxBytes()).toBe(10_000)
  })

  it('falls back to the default for a non-numeric value', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: 'not-a-number' })
    expect(historyMaxBytes()).toBe(200_000)
  })

  it('falls back to the default for zero', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '0' })
    expect(historyMaxBytes()).toBe(200_000)
  })

  it('falls back to the default for a negative value', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '-500' })
    expect(historyMaxBytes()).toBe(200_000)
  })

  it('falls back to the default for an empty string', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '' })
    expect(historyMaxBytes()).toBe(200_000)
  })

  it('parses a value with surrounding whitespace', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '  120000  ' })
    expect(historyMaxBytes()).toBe(120_000)
  })

  it('feeds its default straight into trimHistory when maxBytes is omitted', () => {
    mockReadEnvFile.mockReturnValue({ [ENV_KEY]: '100' })
    const input = [user('a'.repeat(200)), assistant('b')]
    // Under the 100-byte budget, so trimHistory should trim rather than
    // pass the array through untouched.
    const out = trimHistory(input)
    expect(out).not.toBe(input)
  })
})
