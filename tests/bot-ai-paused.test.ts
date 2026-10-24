/**
 * A paused managed box tells the owner once, then at most once a day.
 * Review focus 4: 20 owner messages, one full reply, no turn saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
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
import { addAuthorizedChat, initDatabase } from '../src/db.js'
import { FIRST_REPLY, MANAGED_AI_FILE, REPEAT_REPLY, readAiLimit, writeAiLimit } from '../src/ai-limit.js'
import { AI_USAGE_FILE, recordManagedSpend, usageWarningText } from '../src/ai-usage.js'

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
  return {
    sent,
    say: (text: string) => handler({ chatId: 'owner', text, type: 'text' }),
    sayFrom: (chatId: string, text: string) => handler({ chatId, text, type: 'text' }),
  }
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

  it('a missing marker (the box just recovered) sends nothing and writes no marker', async () => {
    rmSync(join(h.store, 'ai-limit.json'))
    h.runAgent.mockResolvedValue({ text: null, aiPaused: 'billing' })
    const { sent, say } = harness()
    await say('hi')
    expect(sent).toEqual([])
    expect(readAiLimit(h.store)).toBeNull()
  })

  it('still sends the reply when stamping the marker fails', async () => {
    h.runAgent.mockResolvedValue({ text: null, aiPaused: 'spend_limit' })
    const { sent, say } = harness()
    // A directory where the temp file would go makes the atomic write throw.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(h.store, `ai-limit.json.${process.pid}.tmp`), { recursive: true })
    try {
      await say('hello')
      expect(sent).toEqual([FIRST_REPLY])
    } finally {
      rmSync(join(h.store, `ai-limit.json.${process.pid}.tmp`), { recursive: true, force: true })
    }
  })

  it('leaves the normal reply path alone', async () => {
    h.runAgent.mockResolvedValue({ text: 'all good', newSessionId: 's1' })
    const { sent, say } = harness()
    await say('hello')
    expect(sent).toEqual(['all good'])
    expect(h.saveTurn).toHaveBeenCalledTimes(1)
  })
})

describe('80% heads-up on a managed box (card #159)', () => {
  beforeEach(() => {
    initDatabase()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T15:00:00Z'))
    h.runAgent.mockReset()
    h.saveTurn.mockReset()
    rmSync(join(h.store, 'ai-limit.json'), { force: true })
    rmSync(join(h.store, AI_USAGE_FILE), { force: true })
    writeFileSync(join(h.store, MANAGED_AI_FILE), JSON.stringify({ since: '2026-10-01T00:00:00.000Z', capUsd: 50 }))
  })
  afterEach(() => {
    rmSync(join(h.store, MANAGED_AI_FILE), { force: true })
    rmSync(join(h.store, AI_USAGE_FILE), { force: true })
    vi.useRealTimers()
  })

  it('follows the reply that finds the box at 80%, once a month', async () => {
    recordManagedSpend(41, { storeDir: h.store })
    h.runAgent.mockResolvedValue({ text: 'all good', newSessionId: 's1' })
    const { sent, say } = harness()
    await say('hello')
    expect(sent).toEqual(['all good', usageWarningText(new Date())])
    await say('again')
    expect(sent).toEqual(['all good', usageWarningText(new Date()), 'all good'])
  })

  it('never sends it to another chat, and keeps it for the owner', async () => {
    recordManagedSpend(41, { storeDir: h.store })
    h.runAgent.mockResolvedValue({ text: 'all good', newSessionId: 's1' })
    addAuthorizedChat('family-group', 'Family', 'owner')
    const { sent, sayFrom } = harness()
    await sayFrom('family-group', 'hello')
    expect(sent).toEqual(['all good'])
    await sayFrom('owner', 'hello')
    expect(sent).toEqual(['all good', 'all good', usageWarningText(new Date())])
  })

  it('says nothing below 80%', async () => {
    recordManagedSpend(39, { storeDir: h.store })
    h.runAgent.mockResolvedValue({ text: 'all good', newSessionId: 's1' })
    const { sent, say } = harness()
    await say('hello')
    expect(sent).toEqual(['all good'])
  })
})
