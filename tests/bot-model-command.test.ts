/**
 * /model in Telegram and Teams (card #270): the menu, a click, a typed name,
 * the choice reaching the agent, and a fresh session when a switch moves the
 * chat to the other runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-model-'))
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
import { getDb, initDatabase, getSession, setSession } from '../src/db.js'
import { getChatModel, setChatModel } from '../src/models/chat-model.js'

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

describe('/model in a chat', () => {
  beforeEach(() => {
    initDatabase()
    getDb().exec('DELETE FROM consumed_buttons')
    setChatModel('owner', '')
    h.runAgent.mockReset()
    h.runAgent.mockResolvedValue({ text: 'ok', newSessionId: 's1' })
    delete process.env['OPENAI_API_KEY']
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = savedKey
  })

  it('shows the menu, and a click switches the chat and reaches the next turn', async () => {
    const { send, sent } = harness()
    await send({ text: '/model' })
    expect(sent.at(-1)!.buttons).toEqual(expect.arrayContaining(['Claude Haiku', 'Claude Sonnet', 'Claude Opus']))
    const menuId = String(sent.length)
    await send({ type: 'callback', callbackData: 'btn:Claude Opus', messageId: menuId })
    expect(sent.at(-1)!.text).toBe('Switched to Claude Opus.')
    expect(getChatModel('owner')).toBe('opus')
    expect(h.runAgent).not.toHaveBeenCalled()
    await send({ text: 'hello' })
    expect(h.runAgent.mock.calls.at(-1)![8]).toEqual({ model: 'opus', chatId: 'owner' })
  })

  it('lists typed choices where there are no buttons', async () => {
    const { send, sent } = harness(false)
    await send({ text: '/model' })
    expect(sent.at(-1)!.text).toContain('/model opus  (Claude Opus)')
    await send({ text: '/model haiku' })
    expect(sent.at(-1)!.text).toBe('Switched to Claude Haiku.')
    expect(getChatModel('owner')).toBe('haiku')
  })

  it('starts a fresh conversation when the switch moves to the other runtime', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test'
    const { send, sent } = harness()
    setSession('owner', 'claude-session-1')
    // Pretend the provider listed one model, through the day's cache.
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(
      join(process.env['AGENT_STORE_DIR']!, 'model-catalog.json'),
      JSON.stringify({ fetchedAt: { openai: Date.now() }, models: { openai: [{ id: 'gpt-5.5' }] } })
    )
    await send({ text: '/model gpt-5.5' })
    expect(sent.at(-1)!.text).toBe('Switched to GPT-5.5. This starts a fresh conversation; what I remember carries over.')
    expect(getChatModel('owner')).toBe('openai:gpt-5.5')
    expect(getSession('owner')).toBeNull()
  })

  it('a click on another card is not taken as a model pick', async () => {
    const { send } = harness()
    await send({ text: '/model' })
    setChatModel('owner', '')
    await send({ type: 'callback', callbackData: 'btn:Send', messageId: '99' })
    expect(getChatModel('owner')).toBeUndefined()
    expect(h.runAgent).toHaveBeenCalledTimes(1)
  })
})
