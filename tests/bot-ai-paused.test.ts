/**
 * A paused managed box tells the owner once, then at most once a day.
 * Review focus 4: 20 owner messages, one full reply, no turn saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  // STORE_DIR is read at config import time, so set it before anything loads.
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ai-paused-'))
  process.env['AGENT_STORE_DIR'] = store
  return { store: store as string, runAgent: vi.fn(), saveTurn: vi.fn() }
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

import { createBot } from '../src/bot.js'
import { initDatabase } from '../src/db.js'
import { FIRST_REPLY, REPEAT_REPLY, readAiLimit, writeAiLimit } from '../src/ai-limit.js'

function harness() {
  const sent: string[] = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons: false,
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
  return { sent, say: (text: string) => handler({ chatId: 'owner', text, type: 'text' }) }
}

describe('owner reply while the AI allowance is used up', () => {
  beforeEach(() => {
    initDatabase()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    h.runAgent.mockReset()
    h.saveTurn.mockReset()
    writeAiLimit({ kind: 'spend_limit', since: '2026-11-02T11:59:00Z' }, h.store)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first reply once, stays quiet for 19 more, repeats after 25 h, saves no turn', async () => {
    h.runAgent.mockResolvedValue({ text: null, aiPaused: 'spend_limit' })
    const { sent, say } = harness()

    await say('hello')
    expect(sent).toEqual([FIRST_REPLY])

    for (let i = 0; i < 19; i++) {
      vi.setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (i + 1) * 3 * 60_000))
      await say(`again ${i}`)
    }
    expect(sent).toEqual([FIRST_REPLY])

    vi.setSystemTime(new Date('2026-11-03T13:00:00Z'))
    await say('still there?')
    expect(sent).toEqual([FIRST_REPLY, REPEAT_REPLY])

    expect(h.saveTurn).not.toHaveBeenCalled()
    expect(sent.some((t) => t === '(no response)')).toBe(false)
  })

  it('treats a missing marker as just-now and still replies once', async () => {
    rmSync(join(h.store, 'ai-limit.json'))
    h.runAgent.mockResolvedValue({ text: null, aiPaused: 'billing' })
    const { sent, say } = harness()
    await say('hi')
    await say('hi again')
    expect(sent).toEqual([FIRST_REPLY])
    expect(readAiLimit(h.store)?.kind).toBe('billing')
  })

  it('leaves the normal reply path alone', async () => {
    h.runAgent.mockResolvedValue({ text: 'all good', newSessionId: 's1' })
    const { sent, say } = harness()
    await say('hello')
    expect(sent).toEqual(['all good'])
    expect(h.saveTurn).toHaveBeenCalledTimes(1)
  })
})
