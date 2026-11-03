/**
 * /effort (card #272): which levels each model takes, matching a stored
 * choice to the turn's model, the Claude CLI's model report, and the choice
 * surviving a restart.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
}))
vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  readEnvFile: mockReadEnvFile,
}))

const STORE = mkdtempSync(join(tmpdir(), 'effort-command-'))
process.env['AGENT_STORE_DIR'] = STORE

let levels: typeof import('../src/models/effort-levels.js')
let effort: typeof import('../src/models/effort.js')
let claudeModels: typeof import('../src/models/claude-models.js')
let command: typeof import('../src/models/effort-command.js')
let runtime: typeof import('../src/runtime/index.js')

const KEYS = ['AGENT_RUNTIME', 'AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_API_KEY', 'AGENT_MODEL']
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  levels = await import('../src/models/effort-levels.js')
  effort = await import('../src/models/effort.js')
  claudeModels = await import('../src/models/claude-models.js')
  command = await import('../src/models/effort-command.js')
  runtime = await import('../src/runtime/index.js')
})

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  mockReadEnvFile.mockReturnValue({})
  rmSync(join(STORE, 'managed-ai.json'), { force: true })
  rmSync(join(STORE, 'claude-models.json'), { force: true })
  rmSync(join(STORE, 'model-catalog.json'), { force: true })
  claudeModels.resetClaudeModelsMemo()
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const ALL = ['low', 'medium', 'high', 'xhigh']

describe('levels per model', () => {
  it('Claude: current models take every level, 4.6 stops at high, older ones have none', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']) {
      expect(levels.claudeEffortLevels(id), id).toEqual(ALL)
    }
    expect(levels.claudeEffortLevels('claude-opus-4-6')).toEqual(['low', 'medium', 'high'])
    expect(levels.claudeEffortLevels('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high'])
    expect(levels.claudeEffortLevels('claude-opus-4-5-20251101')).toEqual(['low', 'medium', 'high'])
    expect(levels.claudeEffortLevels('claude-sonnet-4-5-20250929')).toEqual([])
    expect(levels.claudeEffortLevels('claude-haiku-4-5')).toEqual([])
    expect(levels.claudeEffortLevels('gpt-5.5')).toBeNull()
    expect(levels.claudeEffortLevels('sonnet')).toBeNull()
  })

  it('other providers: reasoning models only, and nothing through a base URL', () => {
    expect(levels.aiSdkEffortLevels('openai', 'gpt-5.5', false)).toEqual(['low', 'medium', 'high'])
    expect(levels.aiSdkEffortLevels('openai', 'gpt-5.5-mini', false)).toEqual(['low', 'medium', 'high'])
    expect(levels.aiSdkEffortLevels('openai', 'gpt-5-chat-latest', false)).toEqual([])
    expect(levels.aiSdkEffortLevels('openai', 'gpt-4.1', false)).toEqual([])
    expect(levels.aiSdkEffortLevels('openai', 'o4-mini', false)).toEqual(['low', 'medium', 'high'])
    expect(levels.aiSdkEffortLevels('openai', 'gpt-5.5', true)).toEqual([])
    expect(levels.aiSdkEffortLevels('google', 'gemini-3-pro', false)).toEqual(['low', 'high'])
    expect(levels.aiSdkEffortLevels('google', 'gemini-3.5-flash', false)).toEqual(['low', 'medium', 'high'])
    expect(levels.aiSdkEffortLevels('google', 'gemini-2.5-pro', false)).toEqual([])
    expect(levels.aiSdkEffortLevels('anthropic', 'claude-opus-5-5', false)).toEqual(ALL)
    expect(levels.aiSdkEffortLevels('azure', 'my-gpt5-deployment', false)).toEqual([])
  })

  it('a stored level the model lacks runs as the nearest one below; none means none', () => {
    expect(levels.fitEffort('xhigh', ALL as never)).toBe('xhigh')
    expect(levels.fitEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(levels.fitEffort('medium', ['low', 'high'])).toBe('low')
    expect(levels.fitEffort('high', [])).toBeUndefined()
    expect(levels.fitEffort(undefined, ALL as never)).toBeUndefined()
    expect(levels.fitEffort('max', ALL as never)).toBeUndefined()
  })

  it('carries the level in each provider\'s own option', () => {
    expect(levels.effortProviderOptions('anthropic', 'high')).toEqual({ anthropic: { effort: 'high' } })
    expect(levels.effortProviderOptions('openai', 'low')).toEqual({ openai: { reasoningEffort: 'low' } })
    expect(levels.effortProviderOptions('google', 'high')).toEqual({ google: { thinkingConfig: { thinkingLevel: 'high' } } })
    expect(levels.effortProviderOptions('azure', 'high')).toBeUndefined()
    expect(levels.effortProviderOptions('anthropic', undefined)).toBeUndefined()
  })
})

describe('the Claude CLI\'s report', () => {
  it('answers for its aliases, survives a restart, and falls back without one', () => {
    // Nothing reported yet: an alias offers every level (the CLI lowers one
    // its model lacks), a full id follows the Claude rule.
    expect(claudeModels.claudeRuntimeLevels('haiku')).toEqual(ALL)
    expect(claudeModels.claudeRuntimeLevels('claude-haiku-4-5')).toEqual([])
    claudeModels.recordClaudeModels([
      { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
      { value: 'haiku', supportsEffort: false },
      { value: 'opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ])
    expect(existsSync(join(STORE, 'claude-models.json'))).toBe(true)
    // A restart: read back from the file.
    claudeModels.resetClaudeModelsMemo()
    expect(claudeModels.claudeRuntimeLevels('sonnet')).toEqual(['low', 'medium', 'high'])
    expect(claudeModels.claudeRuntimeLevels('haiku')).toEqual([])
    expect(claudeModels.claudeRuntimeLevels('opus')).toEqual(ALL)
  })

  it('a broken file or an empty report changes nothing', () => {
    writeFileSync(join(STORE, 'claude-models.json'), '{not json')
    expect(claudeModels.claudeRuntimeLevels('opus')).toEqual(ALL)
    claudeModels.recordClaudeModels([])
    expect(claudeModels.claudeRuntimeLevels('opus')).toEqual(ALL)
  })
})

describe('the levels for a chat', () => {
  it('claude runtime: the box model or the chat\'s tier', () => {
    claudeModels.recordClaudeModels([
      { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', supportsEffort: false },
    ])
    expect(effort.effortLevelsFor('chat', undefined)).toEqual(['low', 'medium', 'high'])
    expect(effort.effortLevelsFor('chat', 'haiku')).toEqual([])
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'claude-opus-5-5' })
    expect(effort.effortLevelsFor('chat', undefined)).toEqual(ALL)
  })

  it('ai-sdk: the chosen provider model, and nothing for a model through AI_BASE_URL', () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    expect(effort.effortLevelsFor('chat', 'openai:gpt-5.5')).toEqual(['low', 'medium', 'high'])
    expect(effort.effortLevelsFor('chat', 'openai:gpt-4.1')).toEqual([])
    mockReadEnvFile.mockReturnValue({ AGENT_RUNTIME: 'ai-sdk', AI_PROVIDER: 'openai', AI_MODEL: 'deepseek-v4', AI_BASE_URL: 'https://api.together.xyz/v1', OPENAI_API_KEY: 'o' })
    expect(effort.effortLevelsFor('chat', undefined)).toEqual([])
  })

  it('a managed open-model box has no effort setting', () => {
    writeFileSync(join(STORE, 'managed-ai.json'), JSON.stringify({ engine: 'open-model' }))
    expect(effort.effortLevelsFor('chat', undefined)).toEqual([])
  })
})

describe('the chat choice survives a restart', () => {
  it('is read back after the database is reopened', async () => {
    const db = await import('../src/db.js')
    db.initDatabase()
    const store = await import('../src/models/chat-effort.js')
    store.setChatEffort('777', 'xhigh')
    db.getDb().close()
    db.initDatabase()
    expect(store.getChatEffort('777')).toBe('xhigh')
    store.setChatEffort('777', '')
    expect(store.getChatEffort('777')).toBeUndefined()
  })
})

describe('runAgent sends only what the model takes', () => {
  it('fits the stored level to the turn\'s model, and drops it for a model without one', async () => {
    const db = await import('../src/db.js')
    db.initDatabase()
    const agent = await import('../src/agent.js')
    const sent: Array<string | undefined> = []
    const fake = {
      id: 'fake',
      run: async (o: { effort?: string }) => (sent.push(o.effort), { text: 'ok' }),
      runOnce: async () => '',
      steer: () => {},
      getActiveWorkspaces: () => new Map(),
    }
    runtime.setAgentRuntime(fake as never)
    try {
      mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'claude-opus-4-6', OPENAI_API_KEY: 'o' })
      await agent.runAgent('hi', undefined, undefined, undefined, undefined, 'chat', undefined, undefined, { effort: 'xhigh' })
      expect(sent.at(-1)).toBe('high')
      await agent.runAgent('hi', undefined, undefined, undefined, undefined, 'chat', undefined, undefined, { effort: 'low' })
      expect(sent.at(-1)).toBe('low')
      await agent.runAgent('hi', undefined, undefined, undefined, undefined, 'chat', undefined, undefined, { model: 'openai:gpt-4.1', effort: 'high' })
      expect(sent.at(-1)).toBeUndefined()
      await agent.runAgent('hi')
      expect(sent.at(-1)).toBeUndefined()
    } finally {
      runtime.setAgentRuntime(null)
    }
  })
})

describe('/effort replies', () => {
  it('parses levels and names', () => {
    expect(command.parseEffort('High')).toBe('high')
    expect(command.parseEffort('extra high')).toBe('xhigh')
    expect(command.parseEffort('x-high')).toBe('xhigh')
    expect(command.parseEffort('default')).toBe('')
    expect(command.parseEffort('turbo')).toBeNull()
    expect(command.effortForClick('High effort')).toBe('high')
    expect(command.effortForClick('Default effort')).toBe('')
    expect(command.effortForClick('High')).toBeUndefined()
  })

  it('offers only the model\'s levels and refuses one it lacks', async () => {
    mockReadEnvFile.mockReturnValue({ AGENT_MODEL: 'claude-opus-4-6' })
    const menu = await command.effortMenu(undefined, 'xhigh')
    expect(menu.buttons).toEqual(['Low effort', 'Medium effort', 'High effort', 'Default effort'])
    expect(menu.text).toContain('Effort: Extra high, running as High on this model')
    const r = await command.setEffort(undefined, undefined, 'xhigh')
    expect(r).toEqual({ ok: false, text: 'claude-opus-4-6 does not offer Extra high. Pick one of: low, medium, high, default.' })
    expect(await command.setEffort(undefined, undefined, 'high')).toEqual({ ok: true, effort: 'high', text: 'Effort set to High.' })
  })

  it('a model without an effort setting says so', async () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    const menu = await command.effortMenu('openai:gpt-4.1', 'high')
    expect(menu.buttons).toEqual([])
    expect(menu.text).toBe('gpt-4.1 has no effort setting, so /effort does not apply to it. Your pick (High) comes back when you switch to a model that has one.')
    expect(await command.setEffort('openai:gpt-4.1', undefined, 'high')).toEqual({ ok: false, text: 'gpt-4.1 has no effort setting, so there is nothing to set.' })
    // Going back to the default always works.
    expect((await command.setEffort('openai:gpt-4.1', 'high', '')).ok).toBe(true)
  })

  it('a /model switch says when the effort does not carry over', () => {
    mockReadEnvFile.mockReturnValue({ OPENAI_API_KEY: 'o' })
    expect(command.effortNoteAfterSwitch('openai:gpt-5.5', 'xhigh')).toBe('Your Extra high effort runs as High on this model.')
    expect(command.effortNoteAfterSwitch('openai:gpt-4.1', 'high')).toContain('has no effort setting')
    expect(command.effortNoteAfterSwitch('openai:gpt-5.5', 'high')).toBe('')
    expect(command.effortNoteAfterSwitch('openai:gpt-5.5', undefined)).toBe('')
  })
})
