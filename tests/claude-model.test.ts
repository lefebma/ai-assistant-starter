/**
 * tests/claude-model.test.ts
 *
 * Regression coverage for the model pin in src/runtime/claude.ts.
 *
 * What this guards against: ClaudeAgentRuntime calls the Agent SDK query()
 * with settingSources: ['project', 'user'], which lets it inherit whatever
 * `model` key lives in ~/.claude/settings.json -- the model you last picked
 * in Claude Code interactively. The `claude` binary vendored with the pinned
 * SDK only understands models it shipped knowing about, so selecting a newer
 * one there took every scheduled task down until the pin landed. The fix
 * passes an explicit `model` (resolveModel()) at both query() call sites.
 *
 * query() is fully mocked -- a unit test must never spawn a real subprocess --
 * so this asserts on the *options object* handed to query(). It deliberately
 * does not try to re-prove the SDK's own precedence between an explicit
 * `model` and settingSources-inherited config; that was verified out-of-band
 * against the real vendored binary. What it proves: both call sites always
 * pass a concrete, non-empty model, and resolveModel()'s precedence
 * (.env AGENT_MODEL > process.env.AGENT_MODEL > default) is wired correctly.
 * A revert that drops `model` from either call site fails this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockReadEnvFile } = vi.hoisted(() => {
  const mockQuery = vi.fn()
  const mockReadEnvFile = vi.fn((): Record<string, string> => ({}))
  return { mockQuery, mockReadEnvFile }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))
vi.mock('../src/env.js', () => ({ readEnvFile: mockReadEnvFile }))

import { ClaudeAgentRuntime } from '../src/runtime/claude.js'

const PINNED_DEFAULT = 'sonnet'

/** Minimal successful SDK event stream, matching what both call sites iterate. */
function fakeConversation(result: string, sessionId = 'sess-test') {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'result', subtype: 'success', result }
  })()
}

function lastQueryOptions(): any {
  const calls = mockQuery.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0].options
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

describe('model pin is applied at both query() call sites', () => {
  it('runOnce passes the pinned default model', async () => {
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe(PINNED_DEFAULT)
  })

  it('run passes the pinned default model', async () => {
    await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(lastQueryOptions().model).toBe(PINNED_DEFAULT)
  })

  it('never passes an empty or undefined model', async () => {
    const runtime = new ClaudeAgentRuntime()
    await runtime.runOnce('a')
    expect(typeof lastQueryOptions().model).toBe('string')
    expect(lastQueryOptions().model.length).toBeGreaterThan(0)

    await runtime.run({ message: 'b' })
    expect(typeof lastQueryOptions().model).toBe('string')
    expect(lastQueryOptions().model.length).toBeGreaterThan(0)
  })

  it('still inherits other settings sources (pin is scoped to `model` only)', async () => {
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().settingSources).toEqual(['project', 'user'])
  })
})

describe('resolveModel precedence', () => {
  it('.env AGENT_MODEL wins over the default', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'opus' })
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe('opus')
  })

  it('.env AGENT_MODEL wins over process.env', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'opus' })
    process.env.AGENT_MODEL = 'haiku'
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe('opus')
  })

  it('process.env AGENT_MODEL is used when .env has none', async () => {
    process.env.AGENT_MODEL = 'haiku'
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe('haiku')
  })

  it('a whitespace-only .env value falls through to the default', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: '   ' })
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe(PINNED_DEFAULT)
  })

  it('resolves the pinned default even when .env is unreadable/empty', async () => {
    mockReadEnvFile.mockReturnValue({})
    await new ClaudeAgentRuntime().runOnce('hello')
    expect(lastQueryOptions().model).toBe(PINNED_DEFAULT)
  })
})
