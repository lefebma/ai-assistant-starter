/**
 * tests/managed-open-model.test.ts
 *
 * Card #268: a managed box on the open-model engine (an OpenAI-compatible US
 * host on the ai-sdk runtime). The host has no workspace limit we can rely on,
 * so the box prices each model call itself, pauses at the cap, and lifts the
 * pause when the month turns over or the cap is raised. A box on the client's
 * own key (BYOK) records nothing. The model is MockLanguageModelV3: offline.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-open-model-${process.pid}`
  return { store: process.env.AGENT_STORE_DIR }
})

const { mockLogger } = vi.hoisted(() => {
  const fn = () => vi.fn()
  return { mockLogger: { info: fn(), warn: fn(), error: fn(), debug: fn(), trace: fn(), fatal: fn(), child: fn() } }
})
vi.mock('../src/logger.js', () => ({ logger: mockLogger }))

import { AI_LIMIT_FILE, AiPausedError, MANAGED_AI_FILE, managedEngine, managedKeyName, readAiLimit, writeAiLimit } from '../src/ai-limit.js'
import { AI_USAGE_FILE, capReached, readAiUsage, readManagedPrices, tokenCostUsd } from '../src/ai-usage.js'
import { capGate, recordStepSpend } from '../src/managed-cap.js'
import { main, reconcileManagedKey, type ManagedAiDeps } from '../src/managed-ai-cli.js'
import { SessionStore } from '../src/runtime/ai-sdk/sessions.js'
import { getAgentRuntime, setAgentRuntime } from '../src/runtime/index.js'

const STORE = h.store as string
// Obviously fake, so secret scanners never flag the fixtures.
const HOST_KEY = 'test-host-key-not-a-real-secret-0001'
const ANTHROPIC_KEY = 'sk-ant-api-test-not-a-real-secret-0002'
const PRICES = { inputPerMTok: 0.3, outputPerMTok: 1.2 }

function flag(extra: Record<string, unknown> = {}): void {
  mkdirSync(STORE, { recursive: true })
  writeFileSync(join(STORE, MANAGED_AI_FILE), JSON.stringify({ since: '2026-10-01T00:00:00.000Z', engine: 'open-model', ...extra }))
}

function spend(usd: number, month = new Date().toISOString().slice(0, 7)): void {
  writeFileSync(join(STORE, AI_USAGE_FILE), JSON.stringify({ month, usd }))
}

function reset(): void {
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
  setAgentRuntime(null)
  process.env.AI_BASE_URL = 'https://host.example/v1'
  process.env.AI_MODEL = 'open-model-test'
})
afterAll(() => rmSync(STORE, { recursive: true, force: true }))

class FakeDb {
  private rows = new Map<string, string>()
  exec(_sql: string): void {}
  prepare(sql: string) {
    if (/SELECT/i.test(sql)) return { get: (id: string) => (this.rows.has(id) ? { messages: this.rows.get(id)! } : undefined) }
    return { run: (id: string, messages: string) => void this.rows.set(id, messages) }
  }
}

function usage(input: number, output: number, cacheRead = 0) {
  return {
    inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  }
}

/** A model that answers each call from the next entry: text, or a read_file tool call. */
async function scriptedModel(steps: Array<{ text?: string; tool?: boolean; input: number; output: number }>) {
  const { simulateReadableStream } = await import('ai')
  const { MockLanguageModelV3 } = await import('ai/test')
  let i = 0
  return new MockLanguageModelV3({
    // runOnce uses generate(); text steps only.
    doGenerate: async () => {
      const s = steps[Math.min(i++, steps.length - 1)]
      return {
        content: [{ type: 'text' as const, text: s.text ?? '' }],
        finishReason: 'stop' as any,
        usage: usage(s.input, s.output) as any,
        warnings: [],
      }
    },
    doStream: async () => {
      const s = steps[Math.min(i++, steps.length - 1)]
      const body = s.tool
        ? [{ type: 'tool-call' as const, toolCallId: `c${i}`, toolName: 'read_file', input: JSON.stringify({ path: 'README.md' }) }]
        : [
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: s.text ?? '' },
            { type: 'text-end' as const, id: 't' },
          ]
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            ...body,
            { type: 'finish' as const, finishReason: (s.tool ? 'tool-calls' : 'stop') as any, usage: usage(s.input, s.output) as any },
          ],
        }),
      }
    },
  })
}

async function runtimeWith(model: unknown) {
  const { AiSdkAgentRuntime } = await import('../src/runtime/ai-sdk/index.js')
  return new AiSdkAgentRuntime(new SessionStore(new FakeDb() as any), model as any)
}

describe('pricing', () => {
  it('prices input, cache reads and output per million tokens', () => {
    expect(tokenCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, PRICES)).toBeCloseTo(1.5, 9)
    // Cache reads at their own price; unset means billed as input.
    const cachedPrices = { ...PRICES, cachedInputPerMTok: 0.03 }
    expect(tokenCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 500_000 }, cachedPrices)).toBeCloseTo(0.165, 9)
    expect(tokenCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 500_000 }, PRICES)).toBeCloseTo(0.3, 9)
  })

  it('ignores missing, negative and non-number counts, and caps cache reads at the input', () => {
    expect(tokenCostUsd({}, PRICES)).toBe(0)
    expect(tokenCostUsd({ inputTokens: -5, outputTokens: Number.NaN }, PRICES)).toBe(0)
    expect(tokenCostUsd({ inputTokens: 100, cachedInputTokens: 900 }, { ...PRICES, cachedInputPerMTok: 0 })).toBe(0)
  })

  it('reads prices only when input and output are both valid', () => {
    flag({ prices: { inputPerMTok: 0.3 } })
    expect(readManagedPrices(STORE)).toBeUndefined()
    flag({ prices: { inputPerMTok: 0.3, outputPerMTok: -1 } })
    expect(readManagedPrices(STORE)).toBeUndefined()
    flag({ prices: { ...PRICES, cachedInputPerMTok: 'x' } })
    expect(readManagedPrices(STORE)).toEqual(PRICES)
  })
})

describe('capGate', () => {
  it('lets a box that is not managed through, writing nothing', () => {
    expect(capGate(STORE)).toEqual({ ok: true })
    expect(existsSync(join(STORE, AI_LIMIT_FILE))).toBe(false)
  })

  it('fails closed without prices or without a cap', () => {
    flag({ capUsd: 25 })
    expect(capGate(STORE)).toEqual({ notSetUp: true })
    flag({ prices: PRICES })
    expect(capGate(STORE)).toEqual({ notSetUp: true })
  })

  it('fails closed without AI_BASE_URL (the host key would go to OpenAI) or AI_MODEL', () => {
    flag({ prices: PRICES, capUsd: 25 })
    delete process.env.AI_BASE_URL
    expect(capGate(STORE)).toEqual({ notSetUp: true })
    process.env.AI_BASE_URL = 'https://host.example/v1'
    delete process.env.AI_MODEL
    expect(capGate(STORE)).toEqual({ notSetUp: true })
  })

  it('stamps the check while paused, so the recovery timer waits its interval', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(25)
    capGate(STORE)
    const { recoveryDue } = await import('../src/ai-limit.js')
    expect(recoveryDue(readAiLimit(STORE)!, new Date())).toBe(false)
  })

  it('pauses at the cap until the start of next month, marked as a cap pause', () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(25)
    const now = new Date('2026-10-31T12:00:00Z')
    spend(25, '2026-10')
    expect(capGate(STORE, now)).toEqual({ paused: 'spend_limit' })
    expect(readAiLimit(STORE)).toMatchObject({ kind: 'spend_limit', source: 'cap', resumesAt: '2026-11-01T00:00:00.000Z' })
  })

  it('keeps an existing pause as it is (what the owner was told survives)', () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(26, '2026-10')
    writeAiLimit({ kind: 'spend_limit', since: '2026-10-20T00:00:00.000Z', source: 'cap', toldFull: true }, STORE)
    capGate(STORE, new Date('2026-10-31T12:00:00Z'))
    expect(readAiLimit(STORE)).toMatchObject({ since: '2026-10-20T00:00:00.000Z', toldFull: true })
  })

  it('lifts the pause when the month turns over', () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(45, '2026-10')
    writeAiLimit({ kind: 'spend_limit', since: '2026-10-30T00:00:00.000Z', source: 'cap' }, STORE)
    expect(capGate(STORE, new Date('2026-11-01T00:00:01Z'))).toEqual({ ok: true })
    expect(readAiLimit(STORE)).toBeNull()
  })

  it('lifts the pause when the cap is raised above this month\'s spend', () => {
    flag({ prices: PRICES, capUsd: 60 })
    spend(45)
    writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString(), source: 'cap' }, STORE)
    expect(capGate(STORE)).toEqual({ ok: true })
    expect(readAiLimit(STORE)).toBeNull()
  })
})

describe('recordStepSpend', () => {
  it('adds each call to the month and pauses the moment the cap is reached', () => {
    flag({ prices: PRICES, capUsd: 1 })
    recordStepSpend({ inputTokens: 1_000_000, outputTokens: 0 }, STORE)
    expect(readAiUsage(STORE)?.usd).toBeCloseTo(0.3, 6)
    expect(readAiLimit(STORE)).toBeNull()
    recordStepSpend({ inputTokens: 0, outputTokens: 1_000_000 }, STORE)
    expect(readAiUsage(STORE)?.usd).toBeCloseTo(1.5, 6)
    expect(capReached(STORE)).toBe(true)
    expect(readAiLimit(STORE)).toMatchObject({ source: 'cap' })
  })

  it('records nothing on a box that is not managed (BYOK) or has no prices', () => {
    recordStepSpend({ inputTokens: 1_000_000 }, STORE)
    expect(existsSync(join(STORE, AI_USAGE_FILE))).toBe(false)
    flag({ capUsd: 25 })
    recordStepSpend({ inputTokens: 1_000_000 }, STORE)
    expect(existsSync(join(STORE, AI_USAGE_FILE))).toBe(false)
  })

  it('never throws on bad input', () => {
    flag({ prices: PRICES, capUsd: 25 })
    expect(() => recordStepSpend(undefined, STORE)).not.toThrow()
    expect(() => recordStepSpend({ inputTokens: Number.NaN }, STORE)).not.toThrow()
  })
})

describe('engine selection', () => {
  it('a managed open-model box runs every lane on ai-sdk, ignoring AGENT_RUNTIME', () => {
    flag({ prices: PRICES, capUsd: 25 })
    process.env.AGENT_RUNTIME = 'claude'
    try {
      expect(getAgentRuntime('chat').id).toBe('ai-sdk')
      expect(getAgentRuntime('cron').id).toBe('ai-sdk')
    } finally {
      delete process.env.AGENT_RUNTIME
    }
  })

  it('a managed flag without an engine stays on claude', () => {
    mkdirSync(STORE, { recursive: true })
    writeFileSync(join(STORE, MANAGED_AI_FILE), JSON.stringify({ since: 'x' }))
    expect(managedEngine(STORE)).toBe('claude')
    expect(getAgentRuntime('chat').id).toBe('claude')
    expect(managedKeyName('claude')).toBe('ANTHROPIC_API_KEY')
    expect(managedKeyName('open-model')).toBe('OPEN_MODEL_API_KEY')
  })
})

describe('ai-sdk runtime on a managed open-model box', () => {
  it('prices a turn into this month\'s spend', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    const rt = await runtimeWith(await scriptedModel([{ text: 'hello', input: 1_000_000, output: 100_000 }]))
    const res = await rt.run({ message: 'hi' })
    expect(res.text).toBe('hello')
    expect(readAiUsage(STORE)?.usd).toBeCloseTo(0.42, 6)
  })

  it('counts every step of a tool loop, not just the last', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    const rt = await runtimeWith(
      await scriptedModel([
        { tool: true, input: 1_000_000, output: 0 },
        { text: 'done', input: 1_000_000, output: 0 },
      ])
    )
    const res = await rt.run({ message: 'read it' })
    expect(res.text).toBe('done')
    expect(readAiUsage(STORE)?.usd).toBeCloseTo(0.6, 6)
  })

  it('stops the tool loop once a step reaches the cap, and reports the pause', async () => {
    flag({ prices: PRICES, capUsd: 0.5 })
    const model = await scriptedModel([
      { tool: true, input: 2_000_000, output: 0 },
      { text: 'never sent', input: 1, output: 1 },
    ])
    const rt = await runtimeWith(model)
    const res = await rt.run({ message: 'read it' })
    expect(model.doStreamCalls).toHaveLength(1)
    expect(res).toMatchObject({ text: null, aiPaused: 'spend_limit' })
    expect(readAiLimit(STORE)).toMatchObject({ source: 'cap' })
  })

  it('does not call the model while paused', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(25)
    const model = await scriptedModel([{ text: 'x', input: 1, output: 1 }])
    const rt = await runtimeWith(model)
    expect(await rt.run({ message: 'hi' })).toEqual({ text: null, aiPaused: 'spend_limit' })
    expect(model.doStreamCalls).toHaveLength(0)
    await expect(rt.runOnce('Reply with exactly one word: ready')).rejects.toBeInstanceOf(AiPausedError)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('does not call the model before prices and a cap are recorded', async () => {
    flag()
    const model = await scriptedModel([{ text: 'x', input: 1, output: 1 }])
    const rt = await runtimeWith(model)
    expect((await rt.run({ message: 'hi' })).text).toBe('The AI connection for this assistant is not set up yet.')
    await expect(rt.runOnce('hi')).rejects.toThrow('not set up')
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('a recovery probe after the month turns over clears the pause and answers', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    spend(45, '2000-01')
    writeAiLimit({ kind: 'spend_limit', since: '2000-01-31T00:00:00.000Z', source: 'cap' }, STORE)
    const rt = await runtimeWith(await scriptedModel([{ text: 'ready', input: 10, output: 1 }]))
    expect(await rt.runOnce('Reply with exactly one word: ready')).toBe('ready')
    expect(readAiLimit(STORE)).toBeNull()
    // The probe itself counts, against the new month.
    expect(readAiUsage(STORE)).toMatchObject({ month: new Date().toISOString().slice(0, 7) })
    expect(readAiUsage(STORE)!.usd).toBeGreaterThan(0)
  })

  it('charges a step the loop guard cut short, which the host bills but never reports', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')
    const call = (id: string) => ({ type: 'tool-call' as const, toolCallId: id, toolName: 'read_file', input: JSON.stringify({ path: 'README.md' }) })
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        // Three identical calls in one step trip the guard before the step finishes.
        stream: simulateReadableStream({ chunks: [{ type: 'stream-start' as const, warnings: [] }, call('a'), call('b'), call('c')] }),
      }),
    })
    const rt = await runtimeWith(model)
    const res = await rt.run({ message: 'loop' })
    expect(res.text).toContain('Loop detected')
    expect(readAiUsage(STORE)!.usd).toBeGreaterThan(0)
  })

  it('does not charge a step refused before any output (a retried 429 is not billed twice)', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    const { simulateReadableStream } = await import('ai')
    const { MockLanguageModelV3 } = await import('ai/test')
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({ chunks: [{ type: 'stream-start' as const, warnings: [] }, { type: 'error' as const, error: new Error('invalid key') }] }),
      }),
    })
    const rt = await runtimeWith(model)
    expect((await rt.run({ message: 'hi' })).text).toContain("couldn't finish")
    expect(existsSync(join(STORE, AI_USAGE_FILE))).toBe(false)
  })

  it('a BYOK box (not managed) records no spend', async () => {
    const rt = await runtimeWith(await scriptedModel([{ text: 'hello', input: 1_000_000, output: 0 }]))
    expect((await rt.run({ message: 'hi' })).text).toBe('hello')
    expect(existsSync(join(STORE, AI_USAGE_FILE))).toBe(false)
  })
})

describe('provider on a managed open-model box', () => {
  it('uses AI_MODEL for every tier and refuses to run without AI_BASE_URL', async () => {
    flag({ prices: PRICES, capUsd: 25 })
    const { resolveModel, configuredProvider } = await import('../src/runtime/ai-sdk/provider.js')
    process.env.AI_PROVIDER = 'anthropic'
    process.env.AI_MODEL_CHEAP = 'some-cheaper-model'
    try {
      expect(configuredProvider()).toBe('openai')
      delete process.env.AI_BASE_URL
      expect(() => resolveModel('haiku')).toThrow('AI_BASE_URL')
    } finally {
      delete process.env.AI_PROVIDER
      delete process.env.AI_MODEL_CHEAP
    }
  })
})

describe('managed-ai CLI, open-model engine', () => {
  function deps(stdin = '', over: Partial<ManagedAiDeps> = {}) {
    const secrets = new Map<string, string>()
    const vault = {
      set: (n: string, v: string) => void secrets.set(n, v),
      has: (n: string) => secrets.has(n),
      get: (n: string) => secrets.get(n),
      delete: (n: string) => secrets.delete(n),
    }
    return { secrets, d: { stdin: async () => stdin, vault, storeDir: STORE, envExists: false, ...over } as ManagedAiDeps }
  }
  const readFlag = () => JSON.parse(readFileSync(join(STORE, MANAGED_AI_FILE), 'utf8'))

  it('set --open-model stores the host key under its own name and names what is missing', async () => {
    const { secrets, d } = deps(HOST_KEY)
    const out = await main(['set', '--open-model'], d)
    expect(secrets.get('OPEN_MODEL_API_KEY')).toBe(HOST_KEY)
    // Voice and any .env openai lane read OPENAI_API_KEY; the host key must never be there.
    expect(secrets.has('OPENAI_API_KEY')).toBe(false)
    expect(secrets.has('ANTHROPIC_API_KEY')).toBe(false)
    expect(readFlag()).toMatchObject({ engine: 'open-model' })
    expect(out).toContain('managed-ai price')
    expect(out).toContain('managed-ai cap')
    expect(out).not.toContain(HOST_KEY)
  })

  it('refuses an Anthropic key for the open model, and other arguments as a possible key', async () => {
    await expect(main(['set', '--open-model'], deps(ANTHROPIC_KEY).d)).rejects.toThrow('Anthropic key')
    await expect(main(['set', HOST_KEY], deps().d)).rejects.toThrow('stdin')
    await expect(main(['set', '--open-model', HOST_KEY], deps().d)).rejects.toThrow('stdin')
  })

  it('switching engines removes the other engine\'s key and keeps cap and prices', async () => {
    const { secrets, d } = deps(ANTHROPIC_KEY)
    await main(['set'], d)
    await main(['cap', '25'], d)
    d.stdin = async () => HOST_KEY
    await main(['set', '--open-model'], d)
    await main(['price', '0.30', '1.20'], d)
    expect(secrets.has('ANTHROPIC_API_KEY')).toBe(false)
    expect(readFlag()).toMatchObject({ engine: 'open-model', capUsd: 25, prices: PRICES })
    d.stdin = async () => ANTHROPIC_KEY
    await main(['set'], d)
    expect(secrets.has('OPEN_MODEL_API_KEY')).toBe(false)
    expect(readFlag().engine).toBeUndefined()
    expect(readFlag()).toMatchObject({ capUsd: 25, prices: PRICES })
  })

  it('price records dollars per million tokens, with an optional cached price', async () => {
    const { d } = deps(HOST_KEY)
    await main(['set', '--open-model'], d)
    expect(await main(['price', '0.30', '1.20', '0.03'], d)).toContain('cached input $0.03')
    expect(readManagedPrices(STORE)).toEqual({ ...PRICES, cachedInputPerMTok: 0.03 })
    await expect(main(['price', '0.30'], d)).rejects.toThrow('Usage')
    await expect(main(['price', '0.30', '-1'], d)).rejects.toThrow('Usage')
  })

  it('price is refused on the claude engine', async () => {
    const { d } = deps(ANTHROPIC_KEY)
    await main(['set'], d)
    await expect(main(['price', '0.30', '1.20'], d)).rejects.toThrow('open-model engine')
  })

  it('the open-model cap cannot be cleared, since it is the only stop', async () => {
    const { d } = deps(HOST_KEY)
    await main(['set', '--open-model'], d)
    await main(['cap', '25'], d)
    await expect(main(['cap', '0'], d)).rejects.toThrow('needs a cap')
    expect(readFlag().capUsd).toBe(25)
  })

  it('status names the engine, runtime, host, model and prices', async () => {
    const { d } = deps(HOST_KEY, { envRuntime: 'claude', envBaseUrl: 'https://api.together.xyz/v1', envModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' })
    await main(['set', '--open-model'], d)
    let out = await main(['status'], d)
    expect(out).toContain('Key: stored')
    expect(out).toContain('Runtime: ai-sdk (AGENT_RUNTIME=claude in .env is ignored while managed)')
    expect(out).toContain('not recorded (the model is not called until they are)')
    await main(['price', '0.3', '1.2'], d)
    out = await main(['status'], d)
    expect(out).toContain('deepseek-ai/DeepSeek-V4.1-Flash-1017 at https://api.together.xyz/v1')
    expect(out).toContain('$0.3 in, $1.2 out per million tokens')
  })

  it('byok removes the host key, and the boot check compares the engine\'s key', async () => {
    const { secrets, d } = deps(HOST_KEY)
    await main(['set', '--open-model'], d)
    expect(reconcileManagedKey(HOST_KEY, STORE)).toBe('managed')
    expect(reconcileManagedKey('the-clients-own-key', STORE)).toBe('dropped')
    await main(['set', '--open-model'], d)
    await main(['byok'], d)
    expect(secrets.has('OPEN_MODEL_API_KEY')).toBe(false)
    expect(existsSync(join(STORE, MANAGED_AI_FILE))).toBe(false)
  })
})
