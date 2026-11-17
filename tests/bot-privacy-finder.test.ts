/** The privacy finder in a chat app (card #275): owner text is queued, and a card's tap never reaches the model. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-privacy-finder-'))
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
    emailAlertsOn: false, scheduledTasks: 0, decisions: 0, voiceReplies: false, importedProjects: false, importedFromChatGPT: false, ownOpenAiKey: false,
  }),
}))

import { createBot, runWebCommand, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import { findEntry, resetPrivacyCache, setChatPrivacy } from '../src/privacy/store.js'
import { markOffered, nextSuggestion, recordFinds } from '../src/privacy/finder/suggestions.js'
import { clearFinderQueue, finderQueueLength, startNameFinder } from '../src/privacy/finder/service.js'
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
  getDb().exec('DELETE FROM consumed_buttons; DELETE FROM privacy_names; DELETE FROM privacy_suggestions')
  resetPrivacyCache()
  clearFinderQueue()
  h.runAgent.mockReset()
  h.runAgent.mockReset()
})
afterEach(async () => {
  await turnsIdle()
})

function offerBrightPath(card: string): void {
  recordFinds([{ kind: 'company', value: 'Bright Path Dental', score: 0.99 }])
  markOffered(nextSuggestion()!.id, card)
}

describe('privacy finder in the bot', () => {
  it('Add on a suggestion card puts the name on the list without the model', async () => {
    const { sent, send } = fakeAdapter(true)
    offerBrightPath('owner:7')
    await send({ type: 'callback', callbackData: 'btn:Add', messageId: '7' })
    expect(findEntry('Bright Path Dental')).toMatchObject({ kind: 'company' })
    expect(sent.at(-1)!.text).toMatch(/^Added Bright Path Dental/)
    expect(h.runAgent).not.toHaveBeenCalled()
  })

  it('queues what the owner types while the filter is on, and never a command', async () => {
    const { send } = fakeAdapter(true)
    const stop = startNameFinder(
      {
        tagger: { tag: async () => [], disabled: () => false, unloadIfIdle: () => undefined },
        send: async () => null, buttons: true, busy: () => false, now: () => new Date(), tz: 'UTC', skip: () => new Set(),
      },
      { worker: false }
    )
    try {
      setChatPrivacy('owner', true)
      await send({ text: '/private' })
      expect(finderQueueLength()).toBe(0)
      h.runAgent.mockRejectedValue(new Error('no model in tests'))
      await send({ text: 'Call Devon Spencer tomorrow' })
      expect(finderQueueLength()).toBe(1)
    } finally {
      stop()
    }
  })

  it('never reads the reply to /secret set', async () => {
    const { sent, send } = fakeAdapter(true)
    const stop = startFinder()
    try {
      setChatPrivacy('owner', true)
      await send({ text: '/secret set MY_PASSPHRASE' })
      await send({ text: 'Blue Falcon Rising', messageId: '9' })
      expect(sent.some((m) => /MY_PASSPHRASE/.test(m.text))).toBe(true)
      expect(finderQueueLength()).toBe(0)
      expect(h.runAgent).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('queues a web message once', async () => {
    fakeAdapter(true)
    const stop = startFinder()
    try {
      setChatPrivacy('owner', true)
      h.runAgent.mockRejectedValue(new Error('no model in tests'))
      await runWebCommand({
        chatId: 'owner',
        conversationId: 'c1',
        text: 'Call Devon Spencer tomorrow',
        hooks: { send: () => '1', edit: () => {}, clearButtons: () => {}, dropUserMessage: () => {}, file: () => {}, turn: async () => {} } as never,
      }).catch(() => undefined)
      expect(finderQueueLength()).toBe(1)
    } finally {
      stop()
    }
  })
})

function startFinder(): () => void {
  return startNameFinder(
    {
      tagger: { tag: async () => [], disabled: () => false, unloadIfIdle: () => undefined },
      send: async () => null, buttons: true, busy: () => false, now: () => new Date(), tz: 'UTC', skip: () => new Set(),
    },
    { worker: false }
  )
}
