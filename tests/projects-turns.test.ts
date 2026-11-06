/** Projects (card #281) through the real message path, with the agent stubbed. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  process.env['AGENT_STORE_DIR'] = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'projects-turns-'))
  return { runAgent: vi.fn(), saveTurn: vi.fn() }
})

vi.mock('../src/config.js', async (orig) => ({ ...((await orig()) as Record<string, unknown>), PRIMARY_CHAT_ID: 'owner' }))
vi.mock('../src/agent.js', async (orig) => ({ ...((await orig()) as Record<string, unknown>), runAgent: h.runAgent }))
vi.mock('../src/memory.js', async (orig) => ({ ...((await orig()) as Record<string, unknown>), saveConversationTurn: h.saveTurn }))

import { createBot, turnsIdle } from '../src/bot.js'
import { addAuthorizedChat, getDb, getSession, initDatabase, setSession } from '../src/db.js'
import { activeProject, getProject, scopeFor, setInstructions } from '../src/projects/store.js'

function harness() {
  const sent: string[] = []
  let handler: (m: unknown) => Promise<void> = async () => {}
  const adapter = {
    supportsEdit: false,
    supportsButtons: false,
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
  return {
    sent,
    send: (text: string) => handler({ chatId: 'owner', text, type: 'text' }),
    say: async (text: string) => { await handler({ chatId: 'owner', text, type: 'text' }); await turnsIdle() },
  }
}

const inProject = async (bot: ReturnType<typeof harness>, name: string) => {
  await bot.say(`/project new ${name}`)
  return activeProject('owner')!
}

describe('a project in the message path', () => {
  beforeEach(() => {
    initDatabase()
    addAuthorizedChat('owner', 'owner', 'owner')
    getDb().exec('DELETE FROM projects; DELETE FROM sessions; DELETE FROM app_state')
    h.saveTurn.mockReset()
    h.runAgent.mockReset()
    h.runAgent.mockImplementation(async () => ({ text: 'A reply long enough to be saved in memory.', newSessionId: 'new-session', aiPaused: false, reads: [] }))
  })

  it('puts the instructions on the turn, and saves to the project', async () => {
    const bot = harness()
    const p = await inProject(bot, 'Acme')
    setInstructions('owner', p.id, 'Write in French.')
    await bot.say('What should the letter say?')
    const [prompt, , , , , , , , opts] = h.runAgent.mock.calls[0]!
    expect(prompt).toContain('Write in French.')
    expect(opts).toMatchObject({ chatId: 'owner', scope: scopeFor('owner', p.id) })
    expect(h.saveTurn.mock.calls[0]![0]).toBe(scopeFor('owner', p.id))
    expect(getSession(scopeFor('owner', p.id))).toBe('new-session')
    expect(getSession('owner')).toBeNull()
  })

  it('leaves General alone after /project off', async () => {
    const bot = harness()
    const p = await inProject(bot, 'Acme')
    setInstructions('owner', p.id, 'Write in French.')
    await bot.say('/project off')
    await bot.say('What is on today?')
    expect(h.runAgent.mock.calls[0]![0]).not.toContain('Write in French.')
    expect(h.saveTurn.mock.calls[0]![0]).toBe('owner')
  })

  it('runs a message queued before a switch in the project it was sent to', async () => {
    const bot = harness()
    const p = await inProject(bot, 'Acme')
    const acme = scopeFor('owner', p.id)
    let release = () => {}
    h.runAgent.mockImplementationOnce(() => new Promise((res) => { release = () => res({ text: 'First reply, long enough to save.', aiPaused: false, reads: [] }) }))
    await bot.send('First message of the morning')
    await bot.send('Second message, still waiting')
    await bot.send('/project off')
    release()
    await turnsIdle()
    expect(h.runAgent).toHaveBeenCalledTimes(2)
    expect(h.runAgent.mock.calls[1]![8]).toMatchObject({ scope: acme })
    expect(h.saveTurn.mock.calls.map((c) => c[0])).toEqual([acme, acme])
    expect(activeProject('owner')).toBeNull()
  })

  it('clears only the project\'s session on /newchat', async () => {
    const bot = harness()
    const p = await inProject(bot, 'Acme')
    setSession('owner', 'general')
    setSession(scopeFor('owner', p.id), 'acme')
    await bot.say('/newchat')
    expect(getSession(scopeFor('owner', p.id))).toBeNull()
    expect(getSession('owner')).toBe('general')
  })

  it('removes a project on a confirmed delete and lands in General', async () => {
    const bot = harness()
    const p = await inProject(bot, 'Acme')
    await bot.say('/project delete Acme confirm')
    expect(bot.sent.at(-1)).toBe('Deleted Acme.')
    expect(getProject('owner', p.id)).toBeNull()
    await bot.say('Back to normal now, thanks')
    expect(h.runAgent.mock.calls[0]![8]).toMatchObject({ scope: 'owner' })
  })
})
