import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
}))

import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../src/runtime/types.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  calls: AgentRunOptions[] = []
  result: AgentRunResult = { text: 'hello there', newSessionId: 'sess-9' }
  partials: string[] = []
  gate: Promise<void> | null = null
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options)
    for (const p of this.partials) options.onPartial?.(p)
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<void>((r) => options.signal?.addEventListener('abort', () => r(), { once: true })),
      ])
    }
    return this.result
  }
  async runOnce(): Promise<string> { return 'once' }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> { return new Map() }
}

let port = 0
let sessions: typeof import('../src/web/sessions.js')
let server: typeof import('../src/http-server.js')
let conv: typeof import('../src/web/conversations.js')
let runtimeMod: typeof import('../src/runtime/index.js')
let bot: typeof import('../src/bot.js')
let rt: FakeRuntime
let cookie = ''

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-chat-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  // Band 5520-5544.
  port = 5520 + Math.floor(Math.random() * 25)
  server.startHttpServer(port)
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready__`)
      break
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  cookie = sessionFor('4242')
})

afterAll(async () => {
  runtimeMod.setAgentRuntime(null)
  await server.stopHttpServer()
})

afterEach(async () => {
  await bot.turnsIdle()
})

const base = () => `http://127.0.0.1:${port}`
function sessionFor(chatId: string): string {
  const { token } = sessions.mintWebLink(chatId)
  return `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
}
const H = (c = cookie) => ({ Cookie: c, 'Content-Type': 'application/json' })
const post = (path: string, body: unknown = {}, c = cookie) =>
  fetch(base() + path, { method: 'POST', headers: H(c), body: JSON.stringify(body) })

function useRuntime(): FakeRuntime {
  rt = new FakeRuntime()
  runtimeMod.setAgentRuntime(rt)
  return rt
}

interface Ev { name: string; data: any }
function parseSse(text: string): Ev[] {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const name = /^event: (.*)$/m.exec(b)![1]!
      const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]!)
      return { name, data }
    })
}

async function newConv(): Promise<string> {
  const r = await post('/api/web/conversations', { projectId: '' })
  return ((await r.json()) as any).conversation.id
}
async function chat(id: string, text: string): Promise<Ev[]> {
  const r = await post(`/api/web/conversations/${id}/chat`, { text })
  expect(r.headers.get('content-type')).toContain('text/event-stream')
  return parseSse(await r.text())
}

describe('web chat', () => {
  it('streams queued, deltas and done, and persists both messages and the session id', async () => {
    useRuntime().partials = ['hel', 'hello']
    const id = await newConv()
    const evs = await chat(id, 'hi')
    // The stream names the message first (Stop uses it), never its words.
    expect(evs[0]!.name).toBe('start')
    expect(evs[0]!.data.item.text).toBeUndefined()
    expect(evs[1]!.name).toBe('user')
    expect(evs[1]!.data.message).toMatchObject({ role: 'user', content: 'hi' })
    expect(evs.find((e) => e.name === 'queued')).toEqual({ name: 'queued', data: { ahead: 0 } })
    expect(evs.filter((e) => e.name === 'delta').map((e) => e.data.text).join('')).toBe('hello')
    const done = evs.at(-1)!
    expect(done.name).toBe('done')
    expect(done.data.cancelled).toBe(false)
    expect(done.data.message.content).toBe('hello there')
    const msgs = conv.listMessages(id)
    expect(msgs.map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'hello there']])
    expect(conv.getConversation('4242', id)!.sessionId).toBe('sess-9')
    expect(conv.getConversation('4242', id)!.title).toBe('hi')
    const listed = (await (await fetch(`${base()}/api/web/conversations/${id}/messages`, { headers: H() })).json()) as any
    expect(listed.messages).toHaveLength(2)
  })

  it('passes the conversation model, effort and session to run()', async () => {
    useRuntime()
    const id = await newConv()
    expect((await post(`/api/web/conversations/${id}`, { model: 'opus', effort: 'high' })).status).toBe(200)
    await chat(id, 'one')
    await chat(id, 'two')
    expect(rt.calls[0]!.model).toBe('opus')
    expect(rt.calls[0]!.effort).toBe('high')
    expect(rt.calls[0]!.sessionId).toBeUndefined()
    expect(rt.calls[1]!.sessionId).toBe('sess-9')
  })

  it('hides another chat\'s conversation and rejects bad model or effort', async () => {
    useRuntime()
    const id = await newConv()
    const foreign = conv.createConversation('9999', '')
    expect((await post(`/api/web/conversations/${foreign.id}/chat`, { text: 'x' })).status).toBe(404)
    expect((await fetch(`${base()}/api/web/conversations/${foreign.id}/messages`, { headers: H() })).status).toBe(404)
    expect((await post(`/api/web/conversations/${foreign.id}/cancel`)).status).toBe(404)
    expect((await post(`/api/web/conversations/${foreign.id}/delete`)).status).toBe(404)
    expect(conv.getConversation('9999', foreign.id)).not.toBeNull()
    expect((await post(`/api/web/conversations/${id}`, { model: 'gpt' })).status).toBe(400)
    expect((await post(`/api/web/conversations/${id}`, { effort: 'max' })).status).toBe(400)
  })

  it('cancel mid-turn ends with done cancelled and stores no assistant message', async () => {
    useRuntime().gate = new Promise(() => {})
    const id = await newConv()
    const p = post(`/api/web/conversations/${id}/chat`, { text: 'long' })
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1))
    const c = (await (await post(`/api/web/conversations/${id}/cancel`)).json()) as any
    expect(c.stopped).toBe(true)
    const evs = parseSse(await (await p).text())
    expect(evs.at(-1)).toEqual({ name: 'done', data: { cancelled: true } })
    expect(conv.listMessages(id).map((m) => m.role)).toEqual(['user'])
  })

  it('queues a second message while one runs, then runs it (card #250)', async () => {
    let release!: () => void
    useRuntime().gate = new Promise<void>((r) => (release = r))
    const id = await newConv()
    const p = post(`/api/web/conversations/${id}/chat`, { text: 'first' })
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1))
    const second = await post(`/api/web/conversations/${id}/chat`, { text: 'second' })
    expect(second.status).toBe(202)
    expect(((await second.json()) as any).item).toMatchObject({ text: 'second', state: 'queued' })
    release()
    await (await p).text()
    await vi.waitFor(() => expect(rt.calls).toHaveLength(2))
    await bot.turnsIdle()
    expect(conv.listMessages(id).map((m) => m.content)).toEqual(['first', 'hello there', 'second', 'hello there'])
  })

  it('does not hand over a file the file panel hides', async () => {
    const rt = useRuntime()
    rt.result = { text: 'here [[file: src/bot.ts]]', newSessionId: 's' }
    const id = await newConv()
    await (await post(`/api/web/conversations/${id}/chat`, { text: 'send it' })).text()
    const m = conv.listMessages(id).at(-1)!
    expect(m.files).toEqual([])
    expect(m.content).toContain('keeps hidden')
  })

  it('stores files and buttons, serves the file, and refuses .env with a note', async () => {
    useRuntime().result = { text: 'See [[file: README.md]] ok\n[[buttons: Yes | No]]', newSessionId: 's' }
    const id = await newConv()
    const evs = await chat(id, 'file please')
    const msg = evs.at(-1)!.data.message
    expect(msg.buttons).toEqual(['Yes', 'No'])
    expect(msg.files).toEqual([{ index: 0, name: 'README.md', kind: 'document' }])
    expect(msg.content).not.toContain('[[')
    const dl = await fetch(`${base()}/api/web/messages/${msg.id}/files/0`, { headers: { Cookie: cookie } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/)
    expect((await dl.text()).length).toBeGreaterThan(0)
    expect((await fetch(`${base()}/api/web/messages/${msg.id}/files/1`, { headers: { Cookie: cookie } })).status).toBe(404)

    rt.result = { text: 'secret [[file: .env]]', newSessionId: 's' }
    const evs2 = await chat(id, 'env')
    const m2 = evs2.at(-1)!.data.message
    expect(m2.files).toEqual([])
    expect(m2.content).toMatch(/\(file not sent: .+\)/)
  })

  it('does not serve a stored file that has since become unsendable', async () => {
    useRuntime()
    const id = await newConv()
    const bad = join(mkdtempSync(join(tmpdir(), 'outside-')), 'x.txt')
    writeFileSync(bad, 'data')
    const mid = conv.addMessage(id, 'assistant', 'x', [{ path: bad, name: 'x.txt', kind: 'document' }])
    expect((await fetch(`${base()}/api/web/messages/${mid}/files/0`, { headers: { Cookie: cookie } })).status).toBe(404)
  })

  it('still stores the reply when the client aborts mid-stream', async () => {
    let release!: () => void
    useRuntime().gate = new Promise<void>((r) => (release = r))
    const id = await newConv()
    const ac = new AbortController()
    const p = fetch(`${base()}/api/web/conversations/${id}/chat`, { method: 'POST', headers: H(), body: '{"text":"x"}', signal: ac.signal }).catch(() => null)
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1))
    ac.abort()
    await p
    // Give the server time to see the socket close before the turn finishes.
    await new Promise((r) => setTimeout(r, 150))
    release()
    await vi.waitFor(() => expect(conv.listMessages(id).some((m) => m.role === 'assistant')).toBe(true))
    expect(conv.getConversation('4242', id)!.sessionId).toBe('sess-9')
  })

  it('sends reset, not a duplicating delta, when a retry restarts the text', async () => {
    useRuntime().partials = ['first try', 'Sec', 'Second']
    const id = await newConv()
    const evs = await chat(id, 'hi')
    const stream = evs.filter((e) => e.name === 'delta' || e.name === 'reset')
    expect(stream).toEqual([
      { name: 'delta', data: { text: 'first try' } },
      { name: 'reset', data: { text: 'Sec' } },
      { name: 'delta', data: { text: 'ond' } },
    ])
  })

  it('a button click goes to the model as [button_click]: <label>, once', async () => {
    useRuntime().result = { text: 'Draft ready\n[[buttons: Send | Discard]]', newSessionId: 's' }
    const id = await newConv()
    const first = (await chat(id, 'draft it')).at(-1)!.data.message
    expect(first.buttons).toEqual(['Send', 'Discard'])
    expect(first.buttonsUsed).toBe(false)

    rt.result = { text: 'Sent.', newSessionId: 's' }
    const evs = await chat(id, '[button_click]: Send')
    expect(evs.at(-1)!.name).toBe('done')
    expect(rt.calls.at(-1)!.message).toContain('[button_click]: Send')
    const msgs = conv.listMessages(id)
    expect(msgs.find((m) => m.role === 'user' && m.content === '[button_click]: Send')).toBeTruthy()
    const listed = (await (await fetch(`${base()}/api/web/conversations/${id}/messages`, { headers: H() })).json()) as any
    expect(listed.messages.find((m: any) => m.id === first.id).buttonsUsed).toBe(true)

    // A second tab still showing the old buttons cannot answer the card again.
    const again = await post(`/api/web/conversations/${id}/chat`, { text: '[button_click]: Discard' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'buttons_used' })
    expect(rt.calls).toHaveLength(2)
  })

  it('refuses a click for a label the latest reply does not offer', async () => {
    useRuntime().result = { text: 'Pick\n[[buttons: Yes | No]]', newSessionId: 's' }
    const id = await newConv()
    await chat(id, 'ask me')
    const r = await post(`/api/web/conversations/${id}/chat`, { text: '[button_click]: Maybe' })
    expect(r.status).toBe(409)
    expect(conv.listMessages(id).filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('sends an error event and stores nothing when the turn fails', async () => {
    useRuntime()
    rt.run = async () => { throw new Error('boom\n    at secret (/x/y.js:1:1)') }
    const id = await newConv()
    const evs = await chat(id, 'fail')
    const e = evs.at(-1)!
    expect(e.name).toBe('error')
    expect(e.data.message).not.toContain('/x/y.js')
    expect(conv.listMessages(id).map((m) => m.role)).toEqual(['user'])
  })

  it('lists newest first and deletes with messages', async () => {
    useRuntime()
    const a = await newConv()
    await chat(a, 'x')
    const l = (await (await fetch(`${base()}/api/web/conversations?project=`, { headers: H() })).json()) as any
    expect(l.conversations[0].id).toBe(a)
    expect((await post(`/api/web/conversations/${a}/delete`)).status).toBe(200)
    expect(conv.listMessages(a)).toEqual([])
  })
})
