/**
 * tests/claude-runtime-managed.test.ts
 *
 * Card #158: on a managed box (store/managed-ai.json present) the claude
 * runtime runs on the vault key as its only lane, stops on spend limits
 * without retrying or switching lanes, and keeps the key out of logs and
 * replies. query() is fully mocked, so nothing spawns.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  // Own store, so the managed flag and marker never leak into another suite.
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-managed-${process.pid}`
  return { store: process.env.AGENT_STORE_DIR }
})

const { mockQuery, mockReadEnvFile, mockGetSecret, mockLogger } = vi.hoisted(() => {
  const fn = () => vi.fn()
  return {
    mockQuery: vi.fn(),
    mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
    mockGetSecret: vi.fn((_name: string): string | undefined => undefined),
    mockLogger: { info: fn(), warn: fn(), error: fn(), debug: fn(), trace: fn(), fatal: fn() },
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }))
vi.mock('../src/env.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/env.js')>()), readEnvFile: mockReadEnvFile }))
vi.mock('../src/vault/index.js', () => ({ getSecret: mockGetSecret }))
vi.mock('../src/logger.js', () => ({ logger: mockLogger }))

import { ClaudeAgentRuntime } from '../src/runtime/claude.js'
import { getAgentRuntime, setAgentRuntime } from '../src/runtime/index.js'
import { AI_LIMIT_FILE, AiPausedError, MANAGED_AI_FILE, clearAiLimit, readAiLimit, writeAiLimit } from '../src/ai-limit.js'

const STORE = h.store as string
// Obviously fake, so secret scanners never flag the fixture.
const KEY = 'test-managed-key-not-a-real-secret-0001'

// Real text captured on 2026-10-24 (task A9). The CLI drops the request id.
const SPEND_RESULT = 'API Error: 400 You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'
const SPEND_400 = `Claude Code returned an error result: ${SPEND_RESULT}`
const TIER_CAP_429 = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Your organization has hit its spend cap"},"request_id":"req_022DEF"}'

function okConversation(result: string, sessionId = 'sess-managed') {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId }
    yield { type: 'result', subtype: 'success', is_error: false, result }
  })()
}

function throwingConversation(message: string) {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sess-throw' }
    throw new Error(message)
  })()
}

function firstQueryOptions(): any {
  return mockQuery.mock.calls[0]?.[0]?.options
}

function setManaged(on: boolean) {
  mkdirSync(STORE, { recursive: true })
  const f = join(STORE, MANAGED_AI_FILE)
  if (on) writeFileSync(f, JSON.stringify({ since: '2026-10-01T00:00:00.000Z' }))
  else rmSync(f, { force: true })
}

function withKey() {
  mockGetSecret.mockImplementation((name: string) => (name === 'ANTHROPIC_API_KEY' ? KEY : undefined))
}

describe('ClaudeAgentRuntime on a managed box', () => {
  beforeEach(() => {
    rmSync(STORE, { recursive: true, force: true })
    mkdirSync(STORE, { recursive: true })
    mockQuery.mockReset()
    mockReadEnvFile.mockReset()
    mockReadEnvFile.mockReturnValue({})
    mockGetSecret.mockReset()
    mockGetSecret.mockReturnValue(undefined)
    for (const f of Object.values(mockLogger)) f.mockClear()
    setManaged(true)
  })

  afterAll(() => {
    rmSync(STORE, { recursive: true, force: true })
  })

  it('runs on the key as the only lane: one query call with the key in the per-call env', async () => {
    withKey()
    mockQuery.mockReturnValue(okConversation('hi'))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.text).toBe('hi')
    expect(result.aiPaused).toBeUndefined()
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(firstQueryOptions().env.ANTHROPIC_API_KEY).toBe(KEY)
    expect(process.env.ANTHROPIC_API_KEY).not.toBe(KEY)
  })

  it('with no key returns the not-set-up reply and never calls query', async () => {
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.text).toBe('The AI connection for this assistant is not set up yet.')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('a thrown spend-limit 400 pauses after one call and writes the marker', async () => {
    withKey()
    mockQuery.mockReturnValue(throwingConversation(SPEND_400))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toMatchObject({ text: null, aiPaused: 'spend_limit' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const m = readAiLimit()
    expect(m?.kind).toBe('spend_limit')
    expect(m?.lastRequestId).toBeUndefined()
    expect(Number.isNaN(Date.parse(m!.since))).toBe(false)
  })

  it('a thrown tier-cap 429 is classified, not retried (Review Focus 2)', async () => {
    withKey()
    mockQuery.mockImplementation(() => throwingConversation(TIER_CAP_429))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toMatchObject({ text: null, aiPaused: 'org_cap' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(readAiLimit()?.kind).toBe('org_cap')
  })

  it('a result event with is_error true is classified, not delivered as the answer (Review Focus 1)', async () => {
    withKey()
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-iserr' }
      yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: SPEND_RESULT }
    })())
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.text).toBeNull()
    expect(result.aiPaused).toBe('spend_limit')
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(readAiLimit()?.kind).toBe('spend_limit')
  })

  it('an error result subtype carrying the limit in errors[] is classified too', async () => {
    withKey()
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [TIER_CAP_429] }
    })())
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toMatchObject({ text: null, aiPaused: 'org_cap' })
  })

  it('marker set and recovery not due: returns aiPaused with zero query calls', async () => {
    withKey()
    writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString() })
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toEqual({ text: null, aiPaused: 'spend_limit' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('marker set and recovery due: stamps lastProbeAt before the call, and success clears the marker', async () => {
    withKey()
    const old = new Date(Date.now() - 60 * 60_000).toISOString()
    writeAiLimit({ kind: 'spend_limit', since: old })
    let probeStampedBeforeCall: string | undefined
    mockQuery.mockImplementation(() => {
      probeStampedBeforeCall = readAiLimit()?.lastProbeAt
      return okConversation('back')
    })
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(probeStampedBeforeCall).toBeDefined()
    expect(Date.parse(probeStampedBeforeCall!)).toBeGreaterThan(Date.parse(old))
    expect(result.text).toBe('back')
    expect(result.aiPaused).toBeUndefined()
    expect(existsSync(join(STORE, AI_LIMIT_FILE))).toBe(false)
  })

  it('a recovery probe that returns a non-limit API error does not clear the marker', async () => {
    withKey()
    const old = new Date(Date.now() - 60 * 60_000).toISOString()
    writeAiLimit({ kind: 'spend_limit', since: old })
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' }
    })())
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.aiPaused).toBeUndefined()
    expect(readAiLimit()?.kind).toBe('spend_limit')
  })

  it('a thrown usage-limit message on the managed lane pauses as spend_limit after one call', async () => {
    withKey()
    mockQuery.mockReturnValue(throwingConversation('You have reached your usage limit for this workspace'))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toMatchObject({ text: null, aiPaused: 'spend_limit' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(readAiLimit()?.kind).toBe('spend_limit')
  })

  it('a rejected rate_limit_event on the managed lane pauses as spend_limit after one call', async () => {
    withKey()
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-rl' }
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 999 } }
    })())
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toMatchObject({ text: null, aiPaused: 'spend_limit' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(readAiLimit()?.kind).toBe('spend_limit')
  })

  it('a failed recovery probe keeps the paused state and what the owner was told', async () => {
    withKey()
    const old = new Date(Date.now() - 60 * 60_000).toISOString()
    writeAiLimit({ kind: 'spend_limit', since: old, toldFull: true, lastToldAt: old })
    mockQuery.mockReturnValue(throwingConversation(SPEND_400))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.aiPaused).toBe('spend_limit')
    const m = readAiLimit()!
    expect(m.since).toBe(old)
    expect(m.toldFull).toBe(true)
    expect(m.lastToldAt).toBe(old)
    expect(m.lastProbeAt).toBeDefined()
  })

  it('never logs the key, and scrubs it from an ordinary error reply', async () => {
    withKey()
    mockQuery.mockReturnValue(throwingConversation(`spawn failed with ANTHROPIC_API_KEY=${KEY} set`))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.text).toMatch(/^Ran into an error and couldn't finish that: /)
    expect(result.text).toContain('[redacted]')
    expect(result.text).not.toContain(KEY)
    const logged = JSON.stringify(Object.values(mockLogger).flatMap((f) => f.mock.calls), (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))
    expect(logged).not.toContain(KEY)
  })

  it('a pause leaves no key in the logs or the marker file', async () => {
    withKey()
    mockQuery.mockReturnValue(throwingConversation(SPEND_400))
    await new ClaudeAgentRuntime().run({ message: 'hello' })
    const logged = JSON.stringify(Object.values(mockLogger).flatMap((f) => f.mock.calls), (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v))
    expect(logged).not.toContain(KEY)
    expect(JSON.stringify(readAiLimit())).not.toContain(KEY)
  })

  it('drops other auth from the per-call env, so the key is the only lane by construction', async () => {
    withKey()
    const saved = { ...process.env }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-should-not-pass'
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-should-not-pass'
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.invalid'
    try {
      mockQuery.mockReturnValueOnce(okConversation('hi')).mockReturnValueOnce(okConversation('ready'))
      const rt = new ClaudeAgentRuntime()
      await rt.run({ message: 'hello' })
      await rt.runOnce('ping')
      for (const call of mockQuery.mock.calls) {
        const env = call[0].options.env
        expect(env.ANTHROPIC_API_KEY).toBe(KEY)
        expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
        expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
        expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
        expect(env.PATH).toBe(process.env.PATH)
      }
      // The parent process env is untouched.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-should-not-pass')
    } finally {
      process.env = saved
    }
  })

  it('a thrown limit clears a queued steer, so it never runs after the pause', async () => {
    withKey()
    const rt = new ClaudeAgentRuntime()
    rt.steer('follow up')
    mockQuery.mockReturnValueOnce(throwingConversation(SPEND_400))
    expect((await rt.run({ message: 'hello' })).aiPaused).toBe('spend_limit')
    clearAiLimit()
    mockQuery.mockReturnValueOnce(okConversation('hi'))
    const next = await rt.run({ message: 'again' })
    expect(next.text).toBe('hi')
    // Two calls: the paused one and this one. A leaked steer would add a third.
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('resolves both lanes to claude even when .env sets AGENT_RUNTIME=ai-sdk', () => {
    mockReadEnvFile.mockReturnValue({ AGENT_RUNTIME: 'ai-sdk', AGENT_RUNTIME_CRON: 'ai-sdk' })
    setAgentRuntime(null)
    try {
      expect(getAgentRuntime('chat').id).toBe('claude')
      expect(getAgentRuntime('cron').id).toBe('claude')
      // Non-managed: the .env choice still applies, as today.
      setManaged(false)
      expect(getAgentRuntime('chat').id).toBe('ai-sdk')
      expect(getAgentRuntime('cron').id).toBe('ai-sdk')
    } finally {
      setAgentRuntime(null)
    }
  })

  describe('runOnce', () => {
    it('injects the key into the per-call env', async () => {
      withKey()
      mockQuery.mockReturnValue(okConversation('ready'))
      await expect(new ClaudeAgentRuntime().runOnce('ping')).resolves.toBe('ready')
      expect(firstQueryOptions().env.ANTHROPIC_API_KEY).toBe(KEY)
    })

    it('throws AiPausedError without calling query while paused', async () => {
      withKey()
      writeAiLimit({ kind: 'billing', since: new Date().toISOString() })
      const p = new ClaudeAgentRuntime().runOnce('ping')
      await expect(p).rejects.toBeInstanceOf(AiPausedError)
      await expect(p).rejects.toMatchObject({ kind: 'billing' })
      expect(mockQuery).not.toHaveBeenCalled()
    })

    it('throws AiPausedError and writes the marker when the call hits a limit', async () => {
      withKey()
      mockQuery.mockReturnValue(throwingConversation(SPEND_400))
      await expect(new ClaudeAgentRuntime().runOnce('ping')).rejects.toBeInstanceOf(AiPausedError)
      expect(readAiLimit()?.kind).toBe('spend_limit')
    })

    it('a recovery probe that returns a non-limit API error throws and does not clear the marker', async () => {
      withKey()
      const old = new Date(Date.now() - 60 * 60_000).toISOString()
      writeAiLimit({ kind: 'spend_limit', since: old, toldFull: true, lastToldAt: old })
      mockQuery.mockReturnValue((async function* () {
        yield { type: 'result', subtype: 'success', is_error: true, result: `API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error ${KEY}"}}` }
      })())
      const p = new ClaudeAgentRuntime().runOnce('ping')
      await expect(p).rejects.toThrow(/API Error: 500/)
      await expect(p).rejects.not.toBeInstanceOf(AiPausedError)
      await p.catch((e: Error) => expect(e.message).not.toContain(KEY))
      const m = readAiLimit()!
      expect(m.kind).toBe('spend_limit')
      expect(m.toldFull).toBe(true)
    })

    it('a thrown usage-limit message pauses as spend_limit', async () => {
      withKey()
      mockQuery.mockReturnValue(throwingConversation('You have reached your usage limit'))
      await expect(new ClaudeAgentRuntime().runOnce('ping')).rejects.toMatchObject({ kind: 'spend_limit' })
      expect(readAiLimit()?.kind).toBe('spend_limit')
    })

    it('throws AiPausedError for an is_error result event', async () => {
      withKey()
      mockQuery.mockReturnValue((async function* () {
        yield { type: 'result', subtype: 'success', is_error: true, result: TIER_CAP_429 }
      })())
      await expect(new ClaudeAgentRuntime().runOnce('ping')).rejects.toMatchObject({ kind: 'org_cap' })
    })
  })
})

describe('ClaudeAgentRuntime on a non-managed box', () => {
  beforeEach(() => {
    rmSync(STORE, { recursive: true, force: true })
    mkdirSync(STORE, { recursive: true })
    mockQuery.mockReset()
    mockGetSecret.mockReset()
    mockGetSecret.mockReturnValue(undefined)
    setManaged(false)
  })

  it('does not classify a limit-looking 400 and writes no marker', async () => {
    // The real wording ("usage limits") also reads as a used-up subscription
    // window here, which is the non-managed box's existing path. What matters
    // is that it never pauses the box.
    mockQuery.mockReturnValue(throwingConversation(SPEND_400))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result.aiPaused).toBeUndefined()
    expect(result.text).not.toMatch(/allowance/)
    expect(existsSync(join(STORE, AI_LIMIT_FILE))).toBe(false)
  })

  it('starts on the subscription lane with no env override', async () => {
    withKey()
    mockQuery.mockReturnValue(okConversation('hi'))
    const result = await new ClaudeAgentRuntime().run({ message: 'hello' })
    expect(result).toEqual({ text: 'hi', newSessionId: 'sess-managed' })
    expect(firstQueryOptions().env).toBeUndefined()
  })

  it('runOnce passes no env and ignores a stray marker', async () => {
    writeAiLimit({ kind: 'billing', since: new Date().toISOString() })
    mockQuery.mockReturnValue(okConversation('ready'))
    await expect(new ClaudeAgentRuntime().runOnce('ping')).resolves.toBe('ready')
    expect(firstQueryOptions().env).toBeUndefined()
  })
})
