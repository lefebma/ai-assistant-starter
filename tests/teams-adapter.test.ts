import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { Readable } from 'node:stream'

// Own SQLite store for this file (see teams-conversations.test.ts).
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-adapter`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import { TeamsAdapter, TEAMS_WEBHOOK_PATH } from '../src/platform/teams/adapter.js'
import type { Activity } from '../src/platform/teams/types.js'
import type { IncomingMessage } from '../src/platform/types.js'
import { getConversation } from '../src/platform/teams/conversations.js'

const APP_ID = '11111111-2222-3333-4444-555555555555'
const BOT_ID = `28:${APP_ID}`

type Sent = { kind: 'send' | 'update' | 'delete' | 'typing'; conversationId: string; activityId?: string; activity?: unknown }

export function fakeConnector(sent: Sent[], nextId = { n: 0 }) {
  return {
    async sendActivity(ref: { conversationId: string }, activity: unknown) {
      sent.push({ kind: 'send', conversationId: ref.conversationId, activity })
      nextId.n++
      return `sent-${nextId.n}`
    },
    async updateActivity(ref: { conversationId: string }, activityId: string, activity: unknown) {
      sent.push({ kind: 'update', conversationId: ref.conversationId, activityId, activity })
    },
    async deleteActivity(ref: { conversationId: string }, activityId: string) {
      sent.push({ kind: 'delete', conversationId: ref.conversationId, activityId })
    },
    async sendTyping(ref: { conversationId: string }) {
      sent.push({ kind: 'typing', conversationId: ref.conversationId })
    },
  }
}

export function inbound(overrides: Partial<Activity>): Activity {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    channelId: 'msteams',
    from: { id: '29:1abc', aadObjectId: 'aad-marc' },
    recipient: { id: BOT_ID },
    conversation: { id: 'a:1conv', tenantId: 't1' },
    ...overrides,
  }
}

function makeAdapter(sent: Sent[], extra: Partial<ConstructorParameters<typeof TeamsAdapter>[0]> = {}) {
  const routes: Array<{ method: string; path: string }> = []
  const adapter = new TeamsAdapter({
    appId: APP_ID,
    appSecret: 'secret',
    validator: { validate: async (h) => h === 'Bearer good' },
    connector: fakeConnector(sent),
    registerRoute: (method, path) => {
      routes.push({ method, path })
      return () => routes.pop()
    },
    ...extra,
  })
  return { adapter, routes }
}

describe('TeamsAdapter inbound', () => {
  let sent: Sent[]
  let received: IncomingMessage[]

  beforeEach(() => {
    sent = []
    received = []
  })

  it('registers the webhook on start and unregisters on stop', async () => {
    const { adapter, routes } = makeAdapter(sent)
    await adapter.start()
    expect(routes).toEqual([{ method: 'POST', path: TEAMS_WEBHOOK_PATH }])
    await adapter.stop()
    expect(routes).toEqual([])
  })

  it('stores the conversation reference and hands a text message to the bot', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ id: 'act-1', text: 'hello' }))
    expect(received).toEqual([{ chatId: 'a:1conv', userId: 'aad-marc', text: 'hello', type: 'text', messageId: 'act-1', updateId: 'act-1' }])
    expect(getConversation('a:1conv')).toMatchObject({ serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: BOT_ID, userId: 'aad-marc', tenantId: 't1' })
  })

  it('processes a duplicate activity id only once', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ id: 'act-dup', text: 'one' }))
    await adapter.processActivity(inbound({ id: 'act-dup', text: 'one again' }))
    expect(received).toHaveLength(1)
  })

  it('downloads an attachment, with the bot token only when the url needs it', async () => {
    const downloads: Array<{ url: string; name: string; headers?: Record<string, string> }> = []
    const { adapter } = makeAdapter(sent, {
      download: async (url, name, headers) => {
        downloads.push({ url, name, headers })
        return `/tmp/uploads/${name}`
      },
      tokens: { token: async () => 'bot-token', invalidate: () => {} } as never,
    })
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(
      inbound({
        text: 'see attached',
        attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'a.pdf', content: { downloadUrl: 'https://f/a.pdf' } }],
      })
    )
    await adapter.processActivity(inbound({ attachments: [{ contentType: 'image/png', contentUrl: 'https://smba/att/1' }] }))
    expect(downloads[0]).toEqual({ url: 'https://f/a.pdf', name: 'a.pdf', headers: undefined })
    expect(downloads[1].headers).toEqual({ Authorization: 'Bearer bot-token' })
    expect(received[0]).toMatchObject({ type: 'document', filePath: '/tmp/uploads/a.pdf', fileName: 'a.pdf', caption: 'see attached' })
    expect(received[1]).toMatchObject({ type: 'photo', filePath: expect.stringMatching(/\.png$/) })
  })

  it('turns the bot being added into a /chatid so the owner learns the id to allow', async () => {
    const { adapter } = makeAdapter(sent)
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(inbound({ type: 'conversationUpdate', membersAdded: [{ id: BOT_ID }] }))
    expect(received[0]).toMatchObject({ chatId: 'a:1conv', text: '/chatid', type: 'text' })
  })

  it('calls the activity hook on every inbound activity', async () => {
    const { adapter } = makeAdapter(sent)
    let ticks = 0
    adapter.onActivity(() => ticks++)
    adapter.onMessage(async () => {})
    await adapter.processActivity(inbound({ type: 'invoke' }))
    await adapter.processActivity(inbound({ text: 'x' }))
    expect(ticks).toBe(2)
  })
})

describe('TeamsAdapter.handleRequest', () => {
  function request(body: string, auth?: string) {
    const req = Readable.from([Buffer.from(body)]) as unknown as import('node:http').IncomingMessage
    ;(req as { headers: Record<string, string> }).headers = auth ? { authorization: auth } : {}
    const out: { status?: number; body: string } = { body: '' }
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out.status = status
        this.headersSent = true
        return this
      },
      end(chunk?: string) {
        if (chunk) out.body += chunk
      },
    } as unknown as import('node:http').ServerResponse
    return { req, res, out }
  }

  it('answers 401 with an empty body when the token is bad', async () => {
    const { adapter } = makeAdapter([])
    const { req, res, out } = request('{}', 'Bearer bad')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(401)
    expect(out.body).toBe('')
  })

  it('answers 400 for malformed JSON', async () => {
    const { adapter } = makeAdapter([])
    const { req, res, out } = request('{not json', 'Bearer good')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(400)
  })

  it('answers 200 before the bot has finished processing', async () => {
    const { adapter } = makeAdapter([])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let handled = false
    adapter.onMessage(async () => {
      await gate
      handled = true
    })
    const { req, res, out } = request(JSON.stringify(inbound({ id: 'act-slow', text: 'slow' })), 'Bearer good')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(200)
    expect(handled).toBe(false)
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(handled).toBe(true)
  })
})
