/** /tips in a chat app and its buttons (card #273): a click never reaches the model. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-tips-'))
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
vi.mock('../src/tips/context.js', () => ({
  tipContext: async () => ({
    mail: true, calendar: true, gmailAccounts: 1, briefingOn: false, travelOn: false, timingOn: false,
    emailAlertsOn: false, scheduledTasks: 0, decisions: 0, voiceReplies: false,
  }),
}))

import { createBot, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import { loadState } from '../src/tips/state.js'
import type { IncomingMessage, PlatformAdapter } from '../src/platform/types.js'

function fakeAdapter(buttons: boolean) {
  let handler: ((m: IncomingMessage) => Promise<void>) | undefined
  const sent: Array<{ text: string; buttons?: string[] }> = []
  const adapter = {
    name: 'fake', maxMessageLength: 4000, supportsEdit: false, supportsButtons: buttons,
    start: async () => {}, stop: async () => {},
    sendMessage: async (_c: string, text: string, o?: { buttons?: string[] }) => {
      sent.push({ text, buttons: o?.buttons })
      return String(sent.length)
    },
    editMessage: async () => {}, sendTyping: async () => {}, sendFile: async () => {},
    answerCallback: async () => {}, clearButtons: async () => {}, deleteMessage: async () => false,
    formatText: (t: string) => t, splitMessage: (t: string) => [t],
    onMessage: (fn: (m: IncomingMessage) => Promise<void>) => { handler = fn },
    onActivity: () => {},
  } as unknown as PlatformAdapter
  createBot(adapter)
  return {
    sent,
    send: async (m: Record<string, unknown>) => {
      await handler!({ chatId: 'owner', type: 'text', text: '', isPrivate: true, ...m } as unknown as IncomingMessage)
      await turnsIdle()
    },
  }
}

beforeEach(() => {
  initDatabase()
  getDb().prepare('DELETE FROM app_state').run()
  getDb().exec('DELETE FROM consumed_buttons')
  h.runAgent.mockReset()
})
afterEach(async () => {
  await turnsIdle()
})

describe('/tips', () => {
  it('shows a tip with buttons, and Not for me hides it without the model', async () => {
    const { sent, send } = fakeAdapter(true)
    await send({ text: '/tips' })
    expect(sent[0]!.text).toMatch(/^Tip: /)
    expect(sent[0]!.buttons).toEqual(['Got it', 'Not for me'])
    const id = loadState().current!.ids[0]!
    await send({ type: 'callback', callbackData: 'btn:Not for me', messageId: '1' })
    expect(loadState().tips[id]?.status).toBe('dismissed')
    expect(sent.at(-1)!.text).toContain('will not suggest')
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('gives a text hint where there are no buttons', async () => {
    const { sent, send } = fakeAdapter(false)
    await send({ text: '/tips' })
    expect(sent[0]!.buttons).toBeUndefined()
    expect(sent[0]!.text).toContain('/tips hide')
  })

  it('marks /tips itself as tried', async () => {
    const { send } = fakeAdapter(true)
    await send({ text: '/tips less' })
    expect(loadState().pace).toBe('less')
    expect(loadState().tips['tips']?.status).toBe('done')
  })
})
