import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'

// Own SQLite store for this file (see teams-conversations.test.ts).
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-adapter`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import { TeamsAdapter, TEAMS_WEBHOOK_PATH, MAX_CARD_TEXTS, MAX_EDIT_STATES } from '../src/platform/teams/adapter.js'
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
    isAuthorizedChat: () => true,
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
    await adapter.processActivity(inbound({ attachments: [{ contentType: 'image/png', contentUrl: 'https://smba.trafficmanager.net/att/1' }] }))
    await adapter.processActivity(inbound({ attachments: [{ contentType: 'image/png', contentUrl: 'https://evil.example/img.png' }] }))
    expect(downloads[0]).toEqual({ url: 'https://f/a.pdf', name: 'a.pdf', headers: undefined })
    expect(downloads[1].headers).toEqual({ Authorization: 'Bearer bot-token' })
    expect(downloads[2].headers).toEqual(undefined)
    expect(received[0]).toMatchObject({ type: 'document', filePath: '/tmp/uploads/a.pdf', fileName: 'a.pdf', caption: 'see attached' })
    expect(received[1]).toMatchObject({ type: 'photo', filePath: expect.stringMatching(/\.png$/) })
  })

  it('downloads a voice message with the bot token and hands it over as a voice type', async () => {
    const downloads: Array<{ url: string; headers?: Record<string, string> }> = []
    const { adapter } = makeAdapter(sent, {
      download: async (url, name, headers) => {
        downloads.push({ url, headers })
        return `/tmp/uploads/${name}`
      },
      tokens: { token: async () => 'bot-token', invalidate: () => {} } as never,
    })
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(
      inbound({ attachments: [{ contentType: 'audio/mp4', contentUrl: 'https://smba.trafficmanager.net/att/voice1' }] })
    )
    expect(downloads[0].headers).toEqual({ Authorization: 'Bearer bot-token' })
    expect(received[0]).toMatchObject({ type: 'voice', filePath: expect.stringMatching(/\.m4a$/) })
  })

  it('does not download an attachment for an unauthorized chat, but still hands it off (unfetched) so the normal access reply still fires', async () => {
    const downloads: Array<{ url: string }> = []
    const { adapter } = makeAdapter(sent, {
      download: async (url, name) => {
        downloads.push({ url })
        return `/tmp/uploads/${name}`
      },
      isAuthorizedChat: () => false,
    })
    adapter.onMessage(async (m) => {
      received.push(m)
    })
    await adapter.processActivity(
      inbound({ attachments: [{ contentType: 'image/png', contentUrl: 'https://attacker.example/whatever' }] })
    )
    expect(downloads).toHaveLength(0)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'photo' })
    expect(received[0]).not.toHaveProperty('filePath')
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
      once(_event: string, cb: () => void) {
        cb()
        return this
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

  it('answers 413 for a body over the cap, after the token check', async () => {
    const { adapter } = makeAdapter([])
    const big = '{"type":"message","text":"' + 'x'.repeat(1_100_000) + '"}'
    const { req, res, out } = request(big, 'Bearer good')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(413)
    const unauth = request(big, 'Bearer bad')
    await adapter.handleRequest(unauth.req, unauth.res)
    expect(unauth.out.status).toBe(401)
  })

  it('drains the oversized body instead of destroying the socket immediately (avoids an RST)', async () => {
    const { adapter } = makeAdapter([])
    const big = '{"type":"message","text":"' + 'x'.repeat(1_100_000) + '"}'
    const { req, res, out } = request(big, 'Bearer good')
    const resOnceSpy = vi.spyOn(res, 'once')
    await adapter.handleRequest(req, res)
    expect(out.status).toBe(413)
    // The old code destroyed the socket the instant the response finished
    // writing (res.once('finish', () => req.destroy())): fine when the body
    // is already fully buffered like this fake stream, but on a real slow
    // client there can still be unread inbound bytes when that fires, and
    // destroying a socket with unread bytes pending makes the OS send RST
    // instead of a graceful FIN - which can drop the still-unacked 413
    // response before the client reads it. The fix drains instead, so
    // nothing hooks 'finish' on the response at all any more.
    expect(resOnceSpy).not.toHaveBeenCalled()
    // The internal body reader must detach its own 'data' listener on
    // rejection, or resuming the stream to drain it would immediately
    // re-trigger the same oversize rejection instead of just discarding the
    // remaining bytes.
    expect(req.listenerCount('data')).toBe(0)
  })

  it('logs auth failures at most once per minute and counts the rest', async () => {
    let clock = 1_000_000
    const { adapter } = makeAdapter([], { now: () => clock })
    const warnings: Array<{ suppressedSinceLast: number }> = []
    const { logger } = await import('../src/logger.js')
    const original = logger.warn.bind(logger)
    ;(logger as { warn: unknown }).warn = (obj: { suppressedSinceLast: number }) => {
      if (obj && typeof obj === 'object' && 'suppressedSinceLast' in obj) warnings.push(obj)
    }
    try {
      for (let i = 0; i < 3; i++) {
        const { req, res } = request('{}', 'Bearer bad')
        await adapter.handleRequest(req, res)
      }
      expect(warnings).toEqual([{ suppressedSinceLast: 0 }])
      clock += 61_000
      const { req, res } = request('{}', 'Bearer bad')
      await adapter.handleRequest(req, res)
      expect(warnings).toEqual([{ suppressedSinceLast: 0 }, { suppressedSinceLast: 2 }])
    } finally {
      ;(logger as { warn: unknown }).warn = original
    }
  })
})

describe('handleRequest over a real socket', () => {
  it('returns 413 to the client instead of resetting the connection on an oversized body', async () => {
    const { adapter } = makeAdapter([])
    const server = createServer((req, res) => void adapter.handleRequest(req, res))
    await new Promise<void>((resolve) => server.listen(0, resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('server did not bind to a port')
      const body = 'x'.repeat(1_100_000)
      const resp = await fetch(`http://127.0.0.1:${address.port}${TEAMS_WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer good' },
        body,
      })
      expect(resp.status).toBe(413)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

import { upsertConversation } from '../src/platform/teams/conversations.js'

describe('TeamsAdapter outbound', () => {
  const REF = { conversationId: 'a:out', serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: BOT_ID, userId: 'aad-marc' }
  let sent: Sent[]

  beforeEach(() => {
    sent = []
    upsertConversation(REF)
  })

  it('does not advertise edit support, so replies are sent rather than streamed', async () => {
    // Teams desktop renders an activity as first sent and only picks up
    // updateActivity on resync, so a streamed reply (whose final text is
    // delivered as an edit of the preview) stayed invisible there until the
    // user quit and reopened Teams. Mobile and web were fine, and the Bot
    // Connector accepted every edit, which is why nothing showed up in the
    // logs. bot.ts gates streaming on this flag.
    const { adapter } = makeAdapter(sent)
    expect(adapter.supportsEdit).toBe(false)
  })

  it('sends markdown text and returns the activity id', async () => {
    const { adapter } = makeAdapter(sent)
    const id = await adapter.sendMessage('a:out', 'hi **there**')
    expect(id).toBe('sent-1')
    expect(sent[0]).toMatchObject({ kind: 'send', conversationId: 'a:out', activity: { type: 'message', text: 'hi **there**', textFormat: 'markdown' } })
  })

  it('sends a card when buttons are requested, and clears it by replacing with plain text', async () => {
    const { adapter } = makeAdapter(sent)
    const id = await adapter.sendMessage('a:out', 'Send this?', { buttons: ['Send', 'Discard'] })
    expect((sent[0].activity as { attachments: unknown[] }).attachments).toHaveLength(1)
    await adapter.clearButtons('a:out', id)
    expect(sent[1]).toMatchObject({ kind: 'update', activityId: id, activity: { type: 'message', text: 'Send this?' } })
  })

  it('edits a message into a card when buttons are passed, and can clear it afterwards', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.editMessage('a:out', 'm7', 'Approve?', { buttons: ['Send', 'Discard'] })
    expect(sent[0]).toMatchObject({ kind: 'update', activityId: 'm7' })
    expect((sent[0].activity as { attachments: unknown[] }).attachments).toHaveLength(1)
    await adapter.clearButtons('a:out', 'm7')
    expect(sent[1]).toMatchObject({ kind: 'update', activityId: 'm7', activity: { type: 'message', text: 'Approve?' } })
  })

  it('is a no-op when asked to clear buttons on a card it does not remember', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.clearButtons('a:out', 'forgotten')
    expect(sent).toEqual([])
  })

  it('throws a clear error when no conversation reference exists yet', async () => {
    const { adapter } = makeAdapter(sent)
    await expect(adapter.sendMessage('a:never', 'x')).rejects.toThrow(/message the bot first/)
  })

  it('sends typing', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.sendTyping('a:out')
    expect(sent[0]).toMatchObject({ kind: 'typing', conversationId: 'a:out' })
  })

  it('throttles edits to one per second per conversation and always lands the latest text', async () => {
    let clock = 10_000
    const { adapter } = makeAdapter(sent, { now: () => clock })
    await adapter.editMessage('a:out', 'm1', 'v1')
    expect(sent).toHaveLength(1)
    clock += 200
    await adapter.editMessage('a:out', 'm1', 'v2')
    clock += 200
    await adapter.editMessage('a:out', 'm1', 'v3')
    expect(sent).toHaveLength(1) // v2 and v3 queued, v2 dropped
    await new Promise((r) => setTimeout(r, 950)) // timer fires at 1000 - 200 = 800 ms real time
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ kind: 'update', activityId: 'm1', activity: { text: 'v3' } })
  })

  it('explains instead of sending files, and refuses to delete user messages', async () => {
    const { adapter } = makeAdapter(sent)
    await adapter.sendFile('a:out', '/tmp/x/report.pdf', 'document')
    expect((sent[0].activity as { text: string }).text).toMatch(/report\.pdf/)
    expect(await adapter.deleteMessage('a:out', 'm1')).toBe(false)
  })

  it('formats text', () => {
    const { adapter } = makeAdapter(sent)
    expect(adapter.formatText('# T\n<b>x</b>')).toBe('**T**\n**x**')
  })

  it('splits long text at newline, then space, then hard boundaries, never over the limit, losing nothing but the separator', () => {
    const { adapter } = makeAdapter(sent)
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const spaced = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
    const solid = 'y'.repeat(20_000)
    for (const [name, text] of [['lines', lines], ['spaced', spaced], ['solid', solid]] as const) {
      const chunks = adapter.splitMessage(text)
      expect(chunks.length, name).toBeGreaterThan(1)
      for (const c of chunks) expect(c.length, name).toBeLessThanOrEqual(8000)
      if (name === 'solid') expect(chunks.join('')).toBe(text)
      else expect(squash(chunks.join(' '))).toBe(squash(text))
    }
    expect(adapter.splitMessage('short')).toEqual(['short'])
  })

  it('bounds cardTexts so a long-running bot cannot grow it forever', async () => {
    const { adapter } = makeAdapter(sent)
    let firstId = ''
    for (let i = 0; i <= MAX_CARD_TEXTS; i++) {
      const id = await adapter.sendMessage('a:out', `msg ${i}`, { buttons: ['Yes'] })
      if (i === 0) firstId = id
    }
    // The oldest entry was evicted to stay under the cap, so clearing its
    // (now-forgotten) card is a no-op instead of calling updateActivity.
    await adapter.clearButtons('a:out', firstId)
    expect(sent.filter((s) => s.kind === 'update')).toHaveLength(0)
  })

  it('bounds the edits map across many distinct conversations, evicting the oldest once past the cap', async () => {
    const CLOCK = 100_000
    const { adapter } = makeAdapter(sent, { now: () => CLOCK })
    const firstConv = 'a:conv-0'
    for (let i = 0; i <= MAX_EDIT_STATES; i++) {
      const conv = `a:conv-${i}`
      upsertConversation({ ...REF, conversationId: conv })
      await adapter.editMessage(conv, `msg-${i}`, 'hello')
    }
    sent.length = 0
    // If the first conversation's coalescing state had survived, editing it
    // again at the same clock tick would fall inside the 1s throttle window
    // and coalesce instead of sending immediately. Eviction resets it to a
    // brand-new conversation, so this send goes out right away.
    await adapter.editMessage(firstConv, 'msg-0', 'hello again')
    expect(sent.filter((s) => s.kind === 'update')).toHaveLength(1)
  })

  it('protects a card that keeps getting re-edited from eviction, even though it was the first one sent', async () => {
    const { adapter } = makeAdapter(sent)
    const activeId = await adapter.sendMessage('a:out', 'active card', { buttons: ['Yes'] })
    // Fill up to (but not over) the cap with other distinct cards, so
    // activeId is the map's oldest entry going into the next step.
    for (let i = 0; i < MAX_CARD_TEXTS - 1; i++) {
      await adapter.sendMessage('a:out', `msg ${i}`, { buttons: ['Yes'] })
    }
    // A genuine re-edit of the active card, not a fresh insert. FIFO
    // (Map.set on an existing key doesn't reorder it) would leave it at the
    // oldest position despite this touch; touch-refreshes-position moves it
    // to the back instead.
    await adapter.editMessage('a:out', activeId, 'active card updated', { buttons: ['Yes'] })
    // One more distinct card pushes the map over cap, forcing an eviction.
    await adapter.sendMessage('a:out', 'tipping card', { buttons: ['Yes'] })
    sent.length = 0
    await adapter.clearButtons('a:out', activeId)
    expect(sent.filter((s) => s.kind === 'update')).toHaveLength(1)
  })
})
