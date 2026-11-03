/**
 * /private in a chat (card #187): it routes, switches the chat, adds a name,
 * keeps the list to the main chat, and the chat id reaches the turn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-private-'))
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

import { COMMAND_MENU, createBot, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import { privacyState, resetPrivacyCache } from '../src/privacy/store.js'

function harness() {
  const sent: string[] = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons: true,
    maxMessageLength: 4096,
    onMessage: (fn: typeof handler) => {
      handler = fn
    },
    formatText: (s: string) => s,
    splitMessage: (s: string) => [s],
    sendMessage: async (_c: string, t: string) => {
      sent.push(t)
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
    send: async (text: string, chatId = 'owner') => {
      await handler({ chatId, type: 'text', text, isPrivate: true })
      await turnsIdle()
    },
  }
}

describe('/private in a chat', () => {
  beforeEach(() => {
    initDatabase()
    getDb().exec("DELETE FROM privacy_names; DELETE FROM app_state WHERE key LIKE 'privacy:%'")
    resetPrivacyCache()
    h.runAgent.mockReset()
    h.runAgent.mockResolvedValue({ text: 'ok', newSessionId: 's1' })
  })

  it('is in the command menu', () => {
    expect(COMMAND_MENU.map((c) => c.command)).toContain('private')
  })

  it('turns the chat on, adds a name and lists it, without reaching the agent', async () => {
    const b = harness()
    await b.send('/private on')
    expect(privacyState('owner').on).toBe(true)
    await b.send('/private add Initech Corporation, Initech')
    await b.send('/private list')
    expect(b.sent.at(-1)).toMatch(/Initech Corporation \(also Initech\) as COMPANY_\d+/)
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('passes the chat id to the turn, so its switch applies', async () => {
    const b = harness()
    await b.send('hello there')
    expect(h.runAgent.mock.calls.at(-1)![8]).toMatchObject({ chatId: 'owner' })
  })
})
