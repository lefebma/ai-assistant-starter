/**
 * Card #232: /cancel from the chat reaches the running turn. Turns run on a
 * queue, so the command is handled while the turn is still going; the turn's
 * signal aborts, a queued message is dropped, the chat keeps its previous
 * session and nothing is saved to memory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bot-cancel-'))
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
import { getSession, initDatabase, setSession } from '../src/db.js'
import { currentRun } from '../src/assurance/effect-journal.js'

function harness() {
  const sent: string[] = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons: true,
    maxMessageLength: 4096,
    onMessage: (fn: typeof handler) => { handler = fn },
    formatText: (s: string) => s,
    splitMessage: (s: string) => [s],
    sendMessage: async (_c: string, t: string) => { sent.push(t); return String(sent.length) },
    editMessage: async () => {},
    deleteMessage: async () => true,
    sendTyping: async () => {},
    clearButtons: async () => {},
    sendFile: async () => {},
  }
  createBot(adapter as never)
  return { sent, send: (m: Record<string, unknown>) => handler({ chatId: 'owner', type: 'text', ...m }) }
}

/** A turn that runs until its signal aborts, then resolves the way both runtimes do. */
function runsUntilCancelled(): Promise<AbortSignal> {
  return new Promise((started) => {
    h.runAgent.mockImplementationOnce((...args: unknown[]) => {
      const signal = args[6] as AbortSignal
      started(signal)
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: null, newSessionId: 'stopped-session' }), { once: true }))
    })
  })
}

describe('/cancel in chat', () => {
  beforeEach(() => {
    initDatabase()
    h.runAgent.mockReset()
    h.saveTurn.mockReset()
  })

  it('stops the running turn and drops the queued one, mid-turn', async () => {
    setSession('owner', 'previous-session')
    const { sent, send } = harness()
    const started = runsUntilCancelled()
    await send({ text: 'do a long thing' })
    const signal = await started
    await send({ text: 'and then this' })

    await send({ text: '/cancel' })
    expect(sent).toContain('Stopping the current reply. Dropped 1 queued message.')
    expect(signal.aborted).toBe(true)
    await turnsIdle()

    expect(h.runAgent).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toBe('Cancelled.')
    expect(getSession('owner')).toBe('previous-session')
    expect(h.saveTurn).not.toHaveBeenCalled()
  })

  it('with nothing running it says so, and the next message runs normally', async () => {
    const { sent, send } = harness()
    await send({ text: '/cancel' })
    expect(sent).toEqual(['Nothing running.'])
    h.runAgent.mockResolvedValueOnce({ text: 'hello', newSessionId: 'fresh' })
    await send({ text: 'hi' })
    await turnsIdle()
    expect(sent.at(-1)).toBe('hello')
  })

  it("a button click's turn still runs under the card's run key once queued (#229)", async () => {
    const { send } = harness()
    let run: string | undefined
    h.runAgent.mockImplementationOnce(async () => { run = currentRun(); return { text: 'sent' } })
    await send({ type: 'callback', callbackData: 'btn:Send', messageId: '55' })
    await turnsIdle()
    expect(run).toMatch(/^card:owner:55$/)
  })
})
