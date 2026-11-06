/**
 * /effort in Telegram and Teams (card #272): the menu, a click, a typed
 * level, the choice reaching the agent, and a /model switch to a model
 * without an effort setting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-effort-'))
  process.env['AGENT_STORE_DIR'] = store
  return { runAgent: vi.fn() }
})

vi.mock('../src/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  PRIMARY_CHAT_ID: 'owner',
}))
vi.mock('../src/agent.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runAgent: h.runAgent,
}))
vi.mock('../src/memory.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  saveConversationTurn: vi.fn(),
}))

import { createBot, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import { setChatModel } from '../src/models/chat-model.js'
import { getChatEffort, setChatEffort } from '../src/models/chat-effort.js'
import { recordClaudeModels, resetClaudeModelsMemo } from '../src/models/claude-models.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function harness(supportsButtons = true) {
  const sent: Array<{ text: string; buttons?: string[] }> = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons,
    maxMessageLength: 4096,
    onMessage: (fn: typeof handler) => {
      handler = fn
    },
    formatText: (s: string) => s,
    splitMessage: (s: string) => [s],
    sendMessage: async (_c: string, t: string, o?: { buttons?: string[] }) => {
      sent.push({ text: t, buttons: o?.buttons })
      return String(sent.length)
    },
    editMessage: async () => {},
    deleteMessage: async () => true,
    sendTyping: async () => {},
    clearButtons: async () => {},
    sendFile: async () => {},
  }
  createBot(adapter as never)
  return {
    sent,
    send: async (m: Record<string, unknown>) => {
      await handler({ chatId: 'owner', type: 'text', text: '', isPrivate: true, ...m })
      await turnsIdle()
    },
  }
}

const savedKey = process.env['OPENAI_API_KEY']

describe('/effort in a chat', () => {
  beforeEach(() => {
    initDatabase()
    getDb().exec('DELETE FROM consumed_buttons')
    setChatModel('owner', '')
    setChatEffort('owner', '')
    resetClaudeModelsMemo()
    recordClaudeModels([
      { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'] },
      { value: 'haiku', supportsEffort: false },
    ])
    h.runAgent.mockReset()
    h.runAgent.mockResolvedValue({ text: 'ok', newSessionId: 's1' })
    delete process.env['OPENAI_API_KEY']
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = savedKey
  })

  it('shows the levels as buttons, and a click sets the chat and reaches the next turn', async () => {
    const { send, sent } = harness()
    await send({ text: '/effort' })
    expect(sent.at(-1)!.buttons).toEqual(['Low effort', 'Medium effort', 'High effort', 'Extra high effort', 'Default effort'])
    await send({ type: 'callback', callbackData: 'btn:High effort', messageId: String(sent.length) })
    expect(sent.at(-1)!.text).toBe('Effort set to High.')
    expect(getChatEffort('owner')).toBe('high')
    expect(h.runAgent).not.toHaveBeenCalled()
    await send({ text: 'hello' })
    expect(h.runAgent.mock.calls.at(-1)![8]).toEqual({ model: undefined, effort: 'high', chatId: 'owner', scope: 'owner' })
  })

  it('lists typed choices where there are no buttons, and takes a typed level', async () => {
    const { send, sent } = harness(false)
    await send({ text: '/effort' })
    expect(sent.at(-1)!.text).toContain('/effort xhigh  (Extra high)')
    await send({ text: '/effort low' })
    expect(sent.at(-1)!.text).toBe('Effort set to Low.')
    await send({ text: '/effort default' })
    expect(sent.at(-1)!.text).toBe('Effort is back on the default.')
    expect(getChatEffort('owner')).toBeUndefined()
  })

  it('a model without an effort setting says so, and /model notes it on a switch', async () => {
    const { send, sent } = harness()
    await send({ text: '/effort xhigh' })
    await send({ text: '/model haiku' })
    expect(sent.at(-1)!.text).toBe('Switched to Claude Haiku. This model has no effort setting, so your Extra high effort is not used on it. It comes back when you switch to a model that has one.')
    await send({ text: '/effort' })
    expect(sent.at(-1)!.buttons).toBeUndefined()
    expect(sent.at(-1)!.text).toContain('has no effort setting')
    // The pick is kept for when the chat moves back.
    expect(getChatEffort('owner')).toBe('xhigh')
  })

  it('switching to another company\'s model fits the effort to it', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test'
    writeFileSync(
      join(process.env['AGENT_STORE_DIR']!, 'model-catalog.json'),
      JSON.stringify({ fetchedAt: { openai: Date.now() }, models: { openai: [{ id: 'gpt-5.5' }] } })
    )
    const { send, sent } = harness()
    await send({ text: '/effort xhigh' })
    await send({ text: '/model gpt-5.5' })
    expect(sent.at(-1)!.text).toContain('Your Extra high effort runs as High on this model.')
  })
})
