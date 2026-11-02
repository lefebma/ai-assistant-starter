/**
 * /model (card #270): the model catalog, model references, which runtime a
 * choice runs on, and the per-chat choice surviving a restart.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
}))
vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  readEnvFile: mockReadEnvFile,
}))

const STORE = mkdtempSync(join(tmpdir(), 'model-command-'))
process.env['AGENT_STORE_DIR'] = STORE

let catalog: typeof import('../src/models/catalog.js')
let runtime: typeof import('../src/runtime/index.js')
let provider: typeof import('../src/runtime/ai-sdk/provider.js')
let modelRef: typeof import('../src/runtime/model-ref.js')
let command: typeof import('../src/models/command.js')

const KEYS = ['AGENT_RUNTIME', 'AI_PROVIDER', 'AI_MODEL', 'AI_MODEL_CHEAP', 'AI_MODEL_STRONG', 'AI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_API_KEY', 'AGENT_MODEL']
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  catalog = await import('../src/models/catalog.js')
  runtime = await import('../src/runtime/index.js')
  provider = await import('../src/runtime/ai-sdk/provider.js')
  modelRef = await import('../src/runtime/model-ref.js')
  command = await import('../src/models/command.js')
})

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  mockReadEnvFile.mockReturnValue({})
  rmSync(join(STORE, 'managed-ai.json'), { force: true })
  rmSync(join(STORE, 'model-catalog.json'), { force: true })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function setManaged(engine: 'claude' | 'open-model'): void {
  writeFileSync(join(STORE, 'managed-ai.json'), JSON.stringify({ engine }))
}

// --- Provider lists, as their endpoints answer ---

const ANTHROPIC_LIST = {
  data: [
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-04-01T00:00:00Z' },
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-3-5-haiku-20241022', display_name: 'Claude Haiku 3.5', created_at: '2024-10-22T00:00:00Z' },
  ],
}
const OPENAI_LIST = {
  data: [
    { id: 'gpt-5.5', created: 1_780_000_000 },
    { id: 'gpt-5', created: 1_750_000_000 },
    { id: 'gpt-5.5-mini', created: 1_780_000_000 },
    { id: 'gpt-5.5-nano', created: 1_780_000_000 },
    { id: 'gpt-5.5-2026-08-01', created: 1_780_000_001 },
    { id: 'gpt-realtime', created: 1_790_000_000 },
    { id: 'text-embedding-3-large', created: 1_700_000_000 },
    { id: 'whisper-1', created: 1_600_000_000 },
  ],
}
const GOOGLE_LIST = {
  models: [
    { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash-lite', displayName: 'Gemini 3 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
  ],
}

function fakeFetch(fail: string[] = []) {
  const calls: string[] = []
  const impl = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    const which = u.includes('anthropic') ? 'anthropic' : u.includes('openai') ? 'openai' : 'google'
    if (fail.includes(which)) return new Response('nope', { status: 503 })
    const body = which === 'anthropic' ? ANTHROPIC_LIST : which === 'openai' ? OPENAI_LIST : GOOGLE_LIST
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function deps(over: Partial<import('../src/models/catalog.js').CatalogDeps> & { env?: Record<string, string> } = {}) {
  const env = over.env ?? {}
  return {
    read: (k: string) => env[k],
    secret: (k: string) => env[k],
    managed: { on: false, engine: 'claude' },
    boxRuntime: 'claude' as const,
    now: 1_000_000,
    ...over,
  }
}

describe('latest model per family', () => {
  it('keeps the newest of each Claude family and drops older generations', () => {
    const picked = catalog.latestPerFamily('anthropic', ANTHROPIC_LIST.data.map((m) => ({ id: m.id, name: m.display_name, created: Date.parse(m.created_at) })))
    expect(picked.map((m) => m.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  it('keeps chat GPT families only: no dated snapshots, audio, embeddings', () => {
    const picked = catalog.latestPerFamily('openai', OPENAI_LIST.data.map((m) => ({ id: m.id, created: m.created * 1000 })))
    expect(picked.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.5-nano'])
  })

  it('orders by the version in the id when there is no date', () => {
    const picked = catalog.latestPerFamily('google', [{ id: 'gemini-2.5-pro' }, { id: 'gemini-3-pro' }, { id: 'gemini-3-flash' }])
    expect(picked.map((m) => m.id)).toEqual(['gemini-3-pro', 'gemini-3-flash'])
  })

  it('labels ids that come without a display name', () => {
    expect(catalog.labelFor('openai', { id: 'gpt-5.5-mini' })).toBe('GPT-5.5 mini')
    expect(catalog.labelFor('google', { id: 'gemini-3-flash-lite' })).toBe('Gemini 3 Flash-Lite')
    expect(catalog.labelFor('anthropic', { id: 'x', name: 'Claude Opus 5.5' })).toBe('Claude Opus 5.5')
  })
})

describe('the choices a box offers', () => {
  it('Claude subscription box with no keys: default plus the three Claude tiers', async () => {
    const { impl, calls } = fakeFetch()
    const choices = await catalog.listModelChoices(deps({ fetchImpl: impl }))
    expect(choices.map((c) => c.ref)).toEqual(['', 'haiku', 'sonnet', 'opus'])
    expect(calls).toEqual([])
  })

  it('Claude and ChatGPT keys: Claude tiers plus the latest GPT models', async () => {
    const { impl } = fakeFetch()
    const choices = await catalog.listModelChoices(deps({ fetchImpl: impl, env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' } }))
    expect(choices.map((c) => c.ref)).toEqual(['', 'haiku', 'sonnet', 'opus', 'openai:gpt-5.5', 'openai:gpt-5.5-mini', 'openai:gpt-5.5-nano'])
    expect(choices.find((c) => c.ref === 'openai:gpt-5.5')!.runtime).toBe('ai-sdk')
  })

  it('ai-sdk box lists the latest Claude ids from Anthropic, and Gemini with a Google key', async () => {
    const { impl } = fakeFetch()
    const choices = await catalog.listModelChoices(
      deps({ fetchImpl: impl, boxRuntime: 'ai-sdk', env: { ANTHROPIC_API_KEY: 'a', GOOGLE_API_KEY: 'g' } })
    )
    expect(choices.map((c) => c.ref)).toEqual([
      '',
      'anthropic:claude-haiku-5-5',
      'anthropic:claude-sonnet-5-5',
      'anthropic:claude-opus-5-5',
      'google:gemini-3-pro',
      'google:gemini-3-flash',
      'google:gemini-3-flash-lite',
    ])
    expect(choices[2]!.label).toBe('Claude Sonnet 5.5')
  })

  it('a host in AI_BASE_URL offers only the configured models, never OpenAI itself', async () => {
    const { impl, calls } = fakeFetch()
    const choices = await catalog.listModelChoices(
      deps({
        fetchImpl: impl,
        boxRuntime: 'ai-sdk',
        env: { AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.together.xyz/v1', AI_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', OPENAI_API_KEY: 't' },
      })
    )
    expect(choices.map((c) => c.ref)).toEqual(['', 'openai:deepseek-ai/DeepSeek-V4.1-Flash-1017'])
    expect(calls.some((u) => u.includes('api.openai.com'))).toBe(false)
  })

  it('Azure offers the configured deployments', async () => {
    const choices = await catalog.listModelChoices(
      deps({ fetchImpl: fakeFetch().impl, boxRuntime: 'ai-sdk', env: { AI_PROVIDER: 'azure', AI_MODEL: 'gpt-main', AI_MODEL_CHEAP: 'gpt-small', AZURE_API_KEY: 'z' } })
    )
    expect(choices.map((c) => c.ref)).toEqual(['', 'azure:gpt-main', 'azure:gpt-small'])
  })

  it('managed Claude box: only the Claude tiers, whatever keys are set', async () => {
    const choices = await catalog.listModelChoices(
      deps({ fetchImpl: fakeFetch().impl, managed: { on: true, engine: 'claude' }, env: { OPENAI_API_KEY: 'o' } })
    )
    expect(choices.map((c) => c.ref)).toEqual(['', 'haiku', 'sonnet', 'opus'])
  })

  it('managed open-model box: only its one model', async () => {
    const choices = await catalog.listModelChoices(
      deps({ fetchImpl: fakeFetch().impl, boxRuntime: 'ai-sdk', managed: { on: true, engine: 'open-model' }, env: { OPENAI_API_KEY: 'o' } })
    )
    expect(choices.map((c) => c.ref)).toEqual([''])
  })

  it('caches lists for a day, and serves the cache when the provider is down', async () => {
    const env = { OPENAI_API_KEY: 'o' }
    const first = fakeFetch()
    await catalog.listModelChoices(deps({ fetchImpl: first.impl, env, now: 1_000_000 }))
    expect(first.calls).toHaveLength(1)
    expect(existsSync(join(STORE, 'model-catalog.json'))).toBe(true)

    const again = fakeFetch()
    await catalog.listModelChoices(deps({ fetchImpl: again.impl, env, now: 1_000_000 + 60_000 }))
    expect(again.calls).toHaveLength(0)

    const down = fakeFetch(['openai'])
    const stale = await catalog.listModelChoices(deps({ fetchImpl: down.impl, env, now: 1_000_000 + 2 * 86_400_000 }))
    expect(down.calls).toHaveLength(1)
    expect(stale.map((c) => c.ref)).toContain('openai:gpt-5.5')
  })

  it('a provider that is down with no cache is left out, never an error', async () => {
    const choices = await catalog.listModelChoices(deps({ fetchImpl: fakeFetch(['openai']).impl, env: { OPENAI_API_KEY: 'o' } }))
    expect(choices.map((c) => c.ref)).toEqual(['', 'haiku', 'sonnet', 'opus'])
  })

  it('the key never reaches the cache file', async () => {
    await catalog.listModelChoices(deps({ fetchImpl: fakeFetch().impl, env: { OPENAI_API_KEY: 'sk-secret-123' } }))
    expect(readFileSync(join(STORE, 'model-catalog.json'), 'utf8')).not.toContain('sk-secret-123')
  })
})

describe('typed /model choices', () => {
  const choices = [
    { ref: '', label: 'Default (Claude Sonnet)', runtime: 'claude' as const },
    { ref: 'opus', label: 'Claude Opus', runtime: 'claude' as const },
    { ref: 'openai:gpt-5.5', label: 'GPT-5.5', runtime: 'ai-sdk' as const },
    { ref: 'openai:gpt-5.5-mini', label: 'GPT-5.5 mini', runtime: 'ai-sdk' as const },
  ]
  it('matches an exact ref, part of a label, and default', () => {
    expect(catalog.matchChoice(choices, 'openai:gpt-5.5-mini')!.ref).toBe('openai:gpt-5.5-mini')
    expect(catalog.matchChoice(choices, 'opus')!.ref).toBe('opus')
    expect(catalog.matchChoice(choices, 'gpt')!.ref).toBe('openai:gpt-5.5')
    expect(catalog.matchChoice(choices, 'default')!.ref).toBe('')
    expect(catalog.matchChoice(choices, 'llama')).toBeUndefined()
  })
})

describe('model references', () => {
  it('parses provider:modelId and keeps the rest of the id whole', () => {
    expect(modelRef.parseModelRef('openai:gpt-5.5')).toEqual({ provider: 'openai', modelId: 'gpt-5.5' })
    expect(modelRef.parseModelRef('openai:deepseek-ai/DeepSeek:x')).toEqual({ provider: 'openai', modelId: 'deepseek-ai/DeepSeek:x' })
    expect(modelRef.parseModelRef('opus')).toBeNull()
    expect(modelRef.parseModelRef('llama:3')).toBeNull()
    expect(modelRef.parseModelRef('')).toBeNull()
  })

  it('resolveModel builds the chosen provider on its own key', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })
    const r = provider.resolveModel('openai:gpt-5.5')
    expect(r.provider).toBe('openai')
    expect(r.modelId).toBe('gpt-5.5')
    expect(provider.configuredProvider('openai:gpt-5.5')).toBe('openai')
  })

  it('a choice whose key was removed falls back to the default model', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' })
    const r = provider.resolveModel('openai:gpt-5.5')
    expect(r.provider).toBe('anthropic')
    expect(provider.configuredProvider('openai:gpt-5.5')).toBe('anthropic')
  })
})

describe('which runtime runs a choice', () => {
  it('another provider on a claude box runs on ai-sdk', () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    expect(runtime.resolveTurnRuntime('chat', 'openai:gpt-5.5')).toEqual({ id: 'ai-sdk', model: 'openai:gpt-5.5' })
    expect(runtime.resolveTurnRuntime('chat', 'opus')).toEqual({ id: 'claude', model: 'opus' })
    expect(runtime.resolveTurnRuntime('chat', undefined)).toEqual({ id: 'claude', model: undefined })
  })

  it('an Anthropic id on the claude runtime is passed bare', () => {
    mockReadEnvFile.mockReturnValue({ ANTHROPIC_API_KEY: 'a' })
    expect(runtime.resolveTurnRuntime('chat', 'anthropic:claude-opus-5-5')).toEqual({ id: 'claude', model: 'claude-opus-5-5' })
  })

  it('a choice whose key was removed goes back to the box default', () => {
    expect(runtime.resolveTurnRuntime('chat', 'openai:gpt-5.5')).toEqual({ id: 'claude', model: undefined })
  })

  it('managed boxes run only what the plan prices', () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    setManaged('claude')
    expect(runtime.resolveTurnRuntime('chat', 'openai:gpt-5.5')).toEqual({ id: 'claude', model: undefined })
    expect(runtime.resolveTurnRuntime('chat', 'haiku')).toEqual({ id: 'claude', model: 'haiku' })
    setManaged('open-model')
    expect(runtime.resolveTurnRuntime('chat', 'opus')).toEqual({ id: 'ai-sdk', model: undefined })
  })

  it('switching between runtimes asks for a fresh conversation; within one it does not', async () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    const cat = { fetchImpl: fakeFetch().impl, read: (k: string) => (k === 'OPENAI_API_KEY' ? 'o' : undefined), secret: (k: string) => (k === 'OPENAI_API_KEY' ? 'o' : undefined), managed: { on: false, engine: 'claude' }, boxRuntime: 'claude' as const }
    const toGpt = await command.switchModel(undefined, 'gpt-5.5-mini', cat)
    expect(toGpt).toMatchObject({ ok: true, freshSession: true })
    const toOpus = await command.switchModel('haiku', 'opus', cat)
    expect(toOpus).toMatchObject({ ok: true, freshSession: false })
    const none = await command.switchModel(undefined, 'llama', cat)
    expect(none.ok).toBe(false)
  })

  it('a menu click maps back to its choice once', async () => {
    const cat = { fetchImpl: fakeFetch().impl, read: () => undefined, secret: () => undefined, managed: { on: false, engine: 'claude' }, boxRuntime: 'claude' as const }
    const menu = await command.modelMenu('chat-1', 'opus', cat)
    expect(menu.text).toContain('Model: Claude Opus')
    expect(menu.buttons).toContain('Claude Haiku')
    expect(command.takeModelClick('chat-1', 'Claude Haiku')).toBe('haiku')
    expect(command.takeModelClick('chat-1', 'Claude Haiku')).toBeUndefined()
    expect(command.takeModelClick('chat-2', 'Claude Haiku')).toBeUndefined()
  })
})

describe('the chat choice survives a restart', () => {
  it('is read back after the database is reopened', async () => {
    const db = await import('../src/db.js')
    db.initDatabase()
    const store = await import('../src/models/chat-model.js')
    store.setChatModel('777', 'openai:gpt-5.5')
    db.getDb().close()
    db.initDatabase()
    expect(store.getChatModel('777')).toBe('openai:gpt-5.5')
    store.setChatModel('777', '')
    expect(store.getChatModel('777')).toBeUndefined()
  })
})
