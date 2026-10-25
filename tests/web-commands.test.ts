/**
 * Slash commands in the web chat go through the same router as Telegram and
 * Teams (routeText in bot.ts), answer into the conversation, and never reach
 * the agent unless the command itself starts a turn.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-commands-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  // Band 5585-5594.
  port = 5585 + Math.floor(Math.random() * 10)
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

const replies = (evs: Ev[]) => evs.filter((e) => e.name === 'reply').map((e) => e.data.message)

describe('web chat commands', () => {
  it('answers /chatid from the router, stores both sides, and never calls the agent', async () => {
    const r = useRuntime()
    const id = await newConv()
    const evs = await chat(id, '/chatid')
    expect(replies(evs).map((m) => m.content)).toEqual(['Your chat ID is: 4242'])
    expect(evs.at(-1)).toEqual({ name: 'done', data: { cancelled: false, command: true } })
    expect(r.calls).toHaveLength(0)
    expect(conv.listMessages(id).map((m) => [m.role, m.content])).toEqual([
      ['user', '/chatid'],
      ['assistant', 'Your chat ID is: 4242'],
    ])
    expect(conv.getConversation('4242', id)!.title).toBe('/chatid')
  })

  it('matches the command word without regard to case, like Telegram', async () => {
    const r = useRuntime()
    const id = await newConv()
    const evs = await chat(id, '/HELP')
    expect(replies(evs)[0].content).toContain('/newchat - Clear session, start fresh')
    expect(r.calls).toHaveLength(0)
  })

  it('/newchat clears this conversation\'s session and leaves the Telegram session alone', async () => {
    useRuntime()
    const db = await import('../src/db.js')
    db.setSession('4242', 'telegram-sess')
    const id = await newConv()
    await chat(id, 'hi')
    expect(conv.getConversation('4242', id)!.sessionId).toBe('sess-9')
    const evs = await chat(id, '/newchat')
    expect(replies(evs).map((m) => m.content)).toEqual(['Session cleared. Starting fresh.'])
    expect(conv.getConversation('4242', id)!.sessionId).toBeFalsy()
    expect(db.getSession('4242')).toBe('telegram-sess')
    // The next turn starts a new agent session.
    await chat(id, 'again')
    expect(rt.calls.at(-1)!.sessionId).toBeUndefined()
  })

  it('sends an unknown command to the agent, as Telegram does', async () => {
    const r = useRuntime()
    const id = await newConv()
    const evs = await chat(id, '/brainstorm a name')
    expect(r.calls).toHaveLength(1)
    expect(evs.at(-1)!.data.message.content).toBe('hello there')
  })

  it('leaves plain text for the agent', async () => {
    const r = useRuntime()
    const id = await newConv()
    const evs = await chat(id, 'what is on today')
    expect(r.calls).toHaveLength(1)
    expect(replies(evs)).toHaveLength(0)
  })

  it('never stores a message the command deleted (a key sent with /secret)', async () => {
    useRuntime()
    const db = await import('../src/db.js')
    db.addAuthorizedChat('777', 'test', '4242')
    const other = sessionFor('777')
    const r = await post('/api/web/conversations', { projectId: '' }, other)
    const id = ((await r.json()) as any).conversation.id
    const res = await post(`/api/web/conversations/${id}/chat`, { text: '/secret set OPENAI_API_KEY sk-not-a-real-key' }, other)
    const evs = parseSse(await res.text())
    expect(evs.map((e) => e.name)).toContain('dropped')
    expect(replies(evs)[0].content).toContain('Only the primary chat can manage secrets.')
    expect(replies(evs)[0].content).not.toContain('could not delete')
    const stored = conv.listMessages(id)
    expect(stored.map((m) => m.role)).toEqual(['assistant'])
    expect(JSON.stringify(stored)).not.toContain('sk-not-a-real-key')
    expect(conv.getConversation('777', id)!.title).toBe('')
  })

  it('runs the support flow: description, then a click on the draft\'s buttons', async () => {
    const r = useRuntime()
    const id = await newConv()
    const ask = await chat(id, '/support')
    expect(replies(ask)[0].content).toContain("What's going wrong?")
    const draft = await chat(id, 'the morning briefing never arrives')
    const card = replies(draft)[0]
    expect(card.content).toContain('the morning briefing never arrives')
    expect(card.buttons).toEqual(['Send', 'Edit', 'Discard'])
    const done = await chat(id, '[button_click]: Discard')
    expect(replies(done).map((m) => m.content)).toEqual(['Support request discarded. Nothing was sent.'])
    expect(r.calls).toHaveLength(0)
    // The card takes one answer.
    const again = await post(`/api/web/conversations/${id}/chat`, { text: '[button_click]: Send' })
    expect(again.status).toBe(409)
  })

  it('keeps the stream open for a turn the command starts (/audit) and shows its answer', async () => {
    const r = useRuntime()
    r.result = { text: 'Your month in review.', newSessionId: 'audit-sess' }
    const id = await newConv()
    const evs = await chat(id, '/audit')
    expect(r.calls).toHaveLength(1)
    expect(replies(evs).map((m) => m.content)).toContain('Your month in review.')
    expect(evs.at(-1)!.data.command).toBe(true)
    expect(conv.listMessages(id).at(-1)!.content).toBe('Your month in review.')
  })

  it('serves the command menu Telegram shows', async () => {
    const res = await fetch(`${base()}/api/web/commands`, { headers: H() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.commands).toEqual(bot.COMMAND_MENU)
    expect(body.commands.map((c: any) => c.command)).toEqual(expect.arrayContaining(['newchat', 'cancel', 'schedule', 'help']))
  })

  it('refuses the command menu without a web session', async () => {
    const res = await fetch(`${base()}/api/web/commands`)
    expect(res.status).toBe(401)
  })
})
