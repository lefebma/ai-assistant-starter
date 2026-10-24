import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const store = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'web-app-cmd-'))
  process.env['AGENT_STORE_DIR'] = store
  return { store: store as string }
})

vi.mock('../src/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  PRIMARY_CHAT_ID: 'owner',
  PUBLIC_HOSTNAME: 'box.example.com',
}))

import { createBot } from '../src/bot.js'
import { initDatabase } from '../src/db.js'
import { exchangeWebLink, listWebSessions, revokeAllWebSessions } from '../src/web/sessions.js'

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
  return { sent, sayFrom: (chatId: string, text: string) => handler({ chatId, text, type: 'text' }) }
}

describe('/app', () => {
  beforeEach(() => { initDatabase(); revokeAllWebSessions('owner') })

  it('replies with a one-time link, and the link signs in', async () => {
    const { sent, sayFrom } = harness()
    await sayFrom('owner', '/app')
    expect(sent[0]).toContain('Here is your sign-in link for the web app. It works once and expires in 15 minutes:')
    const m = sent[0]!.match(/https:\/\/box\.example\.com\/app#token=(\S+)/)
    expect(m).not.toBeNull()
    expect(exchangeWebLink(m![1]!, 'test')?.chatId).toBe('owner')
  })

  it('/app signout revokes every session for the chat and says how many', async () => {
    const { sent, sayFrom } = harness()
    await sayFrom('owner', '/app')
    const t1 = sent[0]!.match(/#token=(\S+)/)![1]!
    exchangeWebLink(t1, 'a')
    await sayFrom('owner', '/app')
    exchangeWebLink(sent[1]!.match(/#token=(\S+)/)![1]!, 'b')
    expect(listWebSessions('owner')).toHaveLength(2)
    await sayFrom('owner', '/app signout')
    expect(sent[2]).toContain('Signed out 2 browsers')
    expect(listWebSessions('owner')).toHaveLength(0)
  })

  it('does not mint a link for a chat that is not allowed', async () => {
    const { sent, sayFrom } = harness()
    await sayFrom('stranger', '/app')
    expect(sent.join('\n')).not.toContain('/app#token=')
  })
})
