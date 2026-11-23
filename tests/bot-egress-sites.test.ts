/** Refused sites in the bot (card #306): a card after the reply, and a tap that reaches the root helper, never the model. */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:net'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs')
  const { join } = require('node:path')
  const { tmpdir } = require('node:os')
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'bot-egress-sites-'))
  return {
    runAgent: vi.fn(),
    sites: [] as string[],
    approver: 'owner' as 'owner' | 'operator',
    socket: join(mkdtempSync(join(tmpdir(), 'egs-')), 's'),
    requests: [] as string[],
  }
})

vi.mock('../src/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  PRIMARY_CHAT_ID: 'owner',
  EGRESS: 'enforce',
  liveEgressSettings: () => ({ allow: '', read: '', approver: h.approver }),
}))
vi.mock('../src/agent.js', async (orig) => ({ ...((await orig()) as Record<string, unknown>), runAgent: h.runAgent }))
vi.mock('../src/egress/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  collectRefusedSites: async (fn: () => Promise<unknown>) => ({ value: await fn(), sites: h.sites }),
}))
vi.mock('../src/egress/hosted.js', async (orig) => ({ ...((await orig()) as Record<string, unknown>), EGRESS_SOCKET: h.socket }))
vi.mock('../src/tips/context.js', () => ({
  tipContext: async () => ({
    mail: true, calendar: true, gmailAccounts: 1, briefingOn: false, travelOn: false, timingOn: false,
    emailAlertsOn: false, scheduledTasks: 0, decisions: 0, voiceReplies: false, importedProjects: false, importedFromChatGPT: false, ownOpenAiKey: false,
  }),
}))

import { createBot, turnsIdle } from '../src/bot.js'
import { getDb, initDatabase } from '../src/db.js'
import type { IncomingMessage, PlatformAdapter } from '../src/platform/types.js'

let server: Server
beforeEach(async () => {
  initDatabase()
  getDb().prepare('DELETE FROM app_state').run()
  getDb().exec('DELETE FROM consumed_buttons; DELETE FROM egress_sites')
  h.runAgent.mockReset()
  h.runAgent.mockResolvedValue({ text: 'I could not open that page.', newSessionId: 's1' })
  h.sites = ['blocked.example.net']
  h.approver = 'owner'
  h.requests = []
  server ??= await new Promise<Server>((ok) => {
    const s = createServer((c) => c.on('data', (b) => { h.requests.push(b.toString().trim()); c.end('ok\n') }))
    s.listen(h.socket, () => ok(s))
  })
})
afterEach(async () => { await turnsIdle() })
afterAll(() => { server?.close() })

function fakeAdapter(buttons: boolean, chatId = 'owner') {
  let handler: ((m: IncomingMessage) => Promise<void>) | undefined
  const sent: Array<{ text: string; buttons?: string[] }> = []
  const adapter = {
    name: 'fake', maxMessageLength: 4000, supportsEdit: false, supportsButtons: buttons,
    start: async () => {}, stop: async () => {},
    sendMessage: async (_c: string, text: string, o?: { buttons?: string[] }) => { sent.push({ text, buttons: o?.buttons }); return String(sent.length) },
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
      await handler!({ chatId, type: 'text', text: '', isPrivate: true, ...m } as unknown as IncomingMessage)
      await turnsIdle()
    },
  }
}

describe('refused sites in a chat app', () => {
  it('asks the owner after the reply, and Allow goes to the root helper without the model', async () => {
    const { sent, send } = fakeAdapter(true)
    await send({ text: 'open blocked.example.net', messageId: '1' })
    const card = sent.findIndex((m) => /Allow blocked\.example\.net\?/.test(m.text))
    expect(card).toBeGreaterThan(-1)
    expect(sent[card]!.buttons).toEqual(['Allow', 'Deny'])
    expect(h.runAgent).toHaveBeenCalledTimes(1)
    await send({ type: 'callback', callbackData: 'btn:Allow', messageId: String(card + 1) })
    expect(h.requests).toEqual(['allow blocked.example.net'])
    expect(sent.at(-1)!.text).toMatch(/^Allowed blocked\.example\.net/)
    expect(h.runAgent).toHaveBeenCalledTimes(1)
  })

  it('offers Ask for access when only whoever runs the box approves', async () => {
    h.approver = 'operator'
    const { sent, send } = fakeAdapter(true)
    await send({ text: 'open it', messageId: '1' })
    expect(sent.find((m) => /blocked\.example\.net/.test(m.text))!.buttons).toEqual(['Ask for access', 'Not needed'])
  })

  it('never asks in another chat, and never twice about one site', async () => {
    const other = fakeAdapter(true, 'someone-else')
    await other.send({ text: 'open it', messageId: '1' })
    expect(other.sent.some((m) => /Allow blocked/.test(m.text))).toBe(false)
    const { sent, send } = fakeAdapter(true)
    await send({ text: 'open it', messageId: '2' })
    await send({ text: 'and again', messageId: '3' })
    expect(sent.filter((m) => /Allow blocked\.example\.net\?/.test(m.text))).toHaveLength(1)
  })

  it('/egress remove goes to the helper', async () => {
    const { sent, send } = fakeAdapter(true)
    await send({ text: '/egress remove old.example.com', messageId: '1' })
    expect(h.requests).toEqual(['remove old.example.com'])
    expect(sent.at(-1)!.text).toMatch(/^Took old\.example\.com off/)
    expect(h.runAgent).not.toHaveBeenCalled()
  })
})
