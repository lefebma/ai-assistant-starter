/**
 * Card #263 through the bot: a reply to a proactive message, or a tap on a
 * briefing's follow-up button, reaches the agent with what the message was
 * about. Other replies and buttons are untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-followup-'))
  process.env['AGENT_STORE_DIR'] = store
  return { runAgent: vi.fn(), saveTurn: vi.fn() }
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
  saveConversationTurn: h.saveTurn,
}))

import { createBot, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import { markSent, recordDecision } from '../src/proactive/store.js'
import { briefingContext } from '../src/proactive/followup.js'

const START = Date.parse('2026-10-30T18:00:00Z')

function harness() {
  const sent: string[] = []
  const cleared: string[] = []
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
    clearButtons: async (_c: string, id: string) => {
      cleared.push(id)
    },
    sendFile: async () => {},
  }
  createBot(adapter as never)
  return {
    sent,
    cleared,
    send: async (m: Record<string, unknown>) => {
      await handler({ chatId: 'owner', type: 'text', text: '', ...m })
      await turnsIdle()
    },
  }
}

function prompt(): string {
  return h.runAgent.mock.calls.at(-1)![0] as string
}

describe('following up on a briefing', () => {
  beforeEach(() => {
    initDatabase()
    getDb().exec('DELETE FROM proactive_decisions')
    getDb().exec('DELETE FROM consumed_buttons')
    h.runAgent.mockReset()
    h.saveTurn.mockReset()
    h.runAgent.mockResolvedValue({ text: 'ok', newSessionId: 's1' })
    const thread = { ref: 't1', subject: 'Cutover date', lastAt: START, lastFromOwner: false, lastInbound: null, messages: 1, messageIds: ['m1'], link: '' }
    const event = {
      account: 'me@x.com', provider: 'google' as const, id: 'e1', seriesKey: 's', title: 'Southtel cutover', startMs: START, endMs: START + 3_600_000,
      location: '', attendees: [{ email: 'devon@client.com', name: 'Devon' }], organizer: false, link: '',
    }
    const id = recordDecision({
      eventKey: 'k', seriesKey: 's', kind: 'briefing', title: 'Southtel cutover', startMs: START, status: 'pending', reason: 'r', text: 'Before Southtel cutover',
      createdAt: START - 1_800_000, context: briefingContext(event, { brief: true, reason: 'r', picks: [{ thread, why: 'w' }], owed: [] }),
    })!
    markSent(id, 'owner', '42', START - 1_800_000)
  })

  it('adds what the briefing was about to a reply to it', async () => {
    const { send } = harness()
    await send({ text: 'what does Devon want?', replyContext: { replyTo: { text: 'Before Southtel cutover', fromSelf: true, messageId: '42' } } })
    expect(prompt()).toContain('reply to one of your proactive messages')
    expect(prompt()).toContain('Thread id: t1. Message ids, newest first: m1')
    expect(prompt()).toContain('what does Devon want?')
  })

  it('leaves other replies as they were', async () => {
    const { send } = harness()
    await send({ text: 'and this?', replyContext: { replyTo: { text: 'something else', fromSelf: true, messageId: '7' } } })
    expect(prompt()).not.toContain('proactive message')
    await send({ text: 'theirs', replyContext: { replyTo: { text: 'Before Southtel cutover', fromSelf: false, fromName: 'Devon', messageId: '42' } } })
    expect(prompt()).not.toContain('proactive message')
  })

  it('runs a turn for each tap on a follow-up button and keeps the buttons', async () => {
    const { send, cleared, sent } = harness()
    await send({ type: 'callback', callbackData: 'btn:Summarise threads', messageId: '42' })
    expect(prompt()).toContain('The owner tapped "Summarise threads" on this briefing.')
    await send({ type: 'callback', callbackData: 'btn:Draft reply', messageId: '42' })
    expect(prompt()).toContain('The owner tapped "Draft reply" on this briefing.')
    await send({ type: 'callback', callbackData: 'btn:Draft reply', messageId: '42' })
    expect(h.runAgent).toHaveBeenCalledTimes(3)
    expect(cleared).toEqual([])
    expect(sent.some((t) => t.startsWith('Already'))).toBe(false)
    // The mail details a tap carries are not saved as the owner's words.
    expect(h.saveTurn).not.toHaveBeenCalled()
  })

  it('treats the same label on another message as an ordinary click', async () => {
    const { send, cleared } = harness()
    await send({ type: 'callback', callbackData: 'btn:Draft reply', messageId: '9' })
    expect(prompt()).toContain('[button_click]: Draft reply')
    expect(cleared).toEqual(['9'])
  })
})
