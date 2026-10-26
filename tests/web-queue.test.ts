/**
 * Messages sent while a reply is still being written (card #250): they wait in
 * the store, run in order, can be edited or removed until they start, survive
 * a reload, and are never sent twice. Fake runtime; no bot is started.
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

type Ev = { name: string; data: any }
function parseSse(text: string): Ev[] {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('event:'))
    .map((b) => ({ name: /^event: (.*)$/m.exec(b)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }))
}

/** Each call can be held open on its own gate; the reply names the message it answers. */
class GatedRuntime implements AgentRuntime {
  readonly id = 'fake'
  calls: string[] = []
  gates: Array<Promise<void> | null> = []
  partials: string[] = []
  buttons = ''
  /** Calls (by index) that come back paused by the AI limit. */
  pausedAt = new Set<number>()
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const n = this.calls.length
    const said = options.message.split('\n').at(-1)!
    this.calls.push(said)
    for (const p of this.partials) options.onPartial?.(p)
    const gate = this.gates[n]
    if (gate) {
      await Promise.race([gate, new Promise<void>((r) => options.signal?.addEventListener('abort', () => r(), { once: true }))])
    }
    if (options.signal?.aborted) return { text: null }
    if (this.pausedAt.has(n)) return { text: null, aiPaused: 'spend_limit' }
    return { text: `re: ${said}${this.buttons}`, newSessionId: 's1' }
  }
  async runOnce(): Promise<string> {
    return 'once'
  }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return new Map()
  }
}

let port = 0
let sessions: typeof import('../src/web/sessions.js')
let server: typeof import('../src/http-server.js')
let conv: typeof import('../src/web/conversations.js')
let queue: typeof import('../src/web/queue.js')
let runtimeMod: typeof import('../src/runtime/index.js')
let bot: typeof import('../src/bot.js')
let rt: GatedRuntime
let cookie = ''

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-queue-'))
  // /secret writes to a vault in a temp folder, never the real one.
  process.env['AGENT_VAULT_DIR'] = mkdtempSync(join(tmpdir(), 'web-queue-vault-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  queue = await import('../src/web/queue.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  // Band 5600-5639.
  port = 5600 + Math.floor(Math.random() * 40)
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
  const { token } = sessions.mintWebLink('4242')
  cookie = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
})

afterAll(async () => {
  runtimeMod.setAgentRuntime(null)
  await server.stopHttpServer()
})

afterEach(async () => {
  await bot.turnsIdle()
})

const base = () => `http://127.0.0.1:${port}`
const H = () => ({ Cookie: cookie, 'Content-Type': 'application/json' })
const post = (path: string, body: unknown = {}) => fetch(base() + path, { method: 'POST', headers: H(), body: JSON.stringify(body) })
const get = async (path: string) => (await fetch(base() + path, { headers: H() })).json() as Promise<any>

function useRuntime(): GatedRuntime {
  rt = new GatedRuntime()
  runtimeMod.setAgentRuntime(rt)
  return rt
}
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}
async function newConv(): Promise<string> {
  return ((await (await post('/api/web/conversations', { projectId: '' })).json()) as any).conversation.id
}
/** Start a turn and hold it open; resolves once the runtime has it. */
async function startHeld(id: string, text: string, g: Promise<void>, index = rt.calls.length): Promise<Promise<Response>> {
  rt.gates[index] = g
  const p = post(`/api/web/conversations/${id}/chat`, { text })
  await vi.waitFor(() => expect(rt.calls.length).toBeGreaterThan(index))
  return p
}
async function enqueue(id: string, text: string, clientId = ''): Promise<{ status: number; item: any }> {
  const r = await post(`/api/web/conversations/${id}/chat`, { text, clientId })
  expect(r.headers.get('content-type')).toContain('application/json')
  return { status: r.status, item: ((await r.json()) as any).item }
}
const history = (id: string) => conv.listMessages(id).map((m) => [m.role, m.content])

async function untilIdle(id: string, roles: number): Promise<void> {
  await vi.waitFor(() => expect(conv.listMessages(id)).toHaveLength(roles), { timeout: 4000 })
  await bot.turnsIdle()
}

describe('web chat queue', () => {
  it('queues messages sent mid-turn and runs them in order, one after another', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    const first = await startHeld(id, 'A', a.promise)
    const b = await enqueue(id, 'B', 'c-b')
    const c = await enqueue(id, 'C', 'c-c')
    expect(b.status).toBe(202)
    expect(b.item).toMatchObject({ text: 'B', state: 'queued', clientId: 'c-b' })
    expect(c.item.state).toBe('queued')
    // Nothing waiting has reached the agent or the history yet.
    expect(rt.calls).toEqual(['A'])
    expect(history(id)).toEqual([['user', 'A']])
    a.open()
    const evs = parseSse(await (await first).text())
    expect(evs.at(-1)!.name).toBe('done')
    await untilIdle(id, 6)
    expect(rt.calls).toEqual(['A', 'B', 'C'])
    expect(history(id)).toEqual([
      ['user', 'A'], ['assistant', 're: A'],
      ['user', 'B'], ['assistant', 're: B'],
      ['user', 'C'], ['assistant', 're: C'],
    ])
    expect(queue.listQueued(id)).toEqual([])
  })

  it('never sends a message twice when the same send is retried', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    const first = await startHeld(id, 'A', a.promise)
    const one = await enqueue(id, 'B', 'same-id')
    const two = await enqueue(id, 'B', 'same-id')
    expect(two.item.id).toBe(one.item.id)
    expect(queue.listQueued(id)).toHaveLength(1)
    // A retry of the turn that is already running does not start it again.
    const again = await post(`/api/web/conversations/${id}/chat`, { text: 'A2', clientId: 'x' })
    expect(again.status).toBe(202)
    a.open()
    await (await first).text()
    await untilIdle(id, 6)
    expect(rt.calls).toEqual(['A', 'B', 'A2'])
    // After it ran, a late retry still finds it, and nothing new starts.
    const late = await enqueue(id, 'B', 'same-id')
    expect(late.item).toMatchObject({ id: one.item.id, state: 'done' })
    await bot.turnsIdle()
    expect(rt.calls).toHaveLength(3)
  })

  it('a waiting message can be edited or removed, and is refused once it has started', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    const b = gate()
    const first = await startHeld(id, 'A', a.promise)
    rt.gates[1] = b.promise
    const B = (await enqueue(id, 'B', 'b')).item
    const C = (await enqueue(id, 'C', 'c')).item
    const edited = await post(`/api/web/conversations/${id}/queue/${B.id}`, { text: 'B, edited' })
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as any).item.text).toBe('B, edited')
    expect((await post(`/api/web/conversations/${id}/queue/${B.id}`, { text: '  ' })).status).toBe(400)
    expect((await post(`/api/web/conversations/${id}/queue/${C.id}/delete`)).status).toBe(200)
    expect((await post(`/api/web/conversations/${id}/queue/${C.id}/delete`)).status).toBe(404)
    expect((await get(`/api/web/conversations/${id}/messages`)).queue.map((q: any) => q.text)).toEqual(['B, edited'])

    a.open()
    await (await first).text()
    await vi.waitFor(() => expect(rt.calls).toEqual(['A', 'B, edited']))
    // B is running now: too late to change it.
    const late = await post(`/api/web/conversations/${id}/queue/${B.id}`, { text: 'nope' })
    expect(late.status).toBe(409)
    expect(await late.json()).toEqual({ error: 'started' })
    expect((await post(`/api/web/conversations/${id}/queue/${B.id}/delete`)).status).toBe(409)
    b.open()
    await untilIdle(id, 4)
    expect(history(id).map((m) => m[1])).toEqual(['A', 're: A', 'B, edited', 're: B, edited'])
  })

  it('Stop ends the running reply only; the queue carries on', async () => {
    useRuntime()
    const id = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    await enqueue(id, 'B', 'b')
    const c = (await (await post(`/api/web/conversations/${id}/cancel`)).json()) as any
    expect(c.stopped).toBe(true)
    expect(parseSse(await (await first).text()).at(-1)).toEqual({ name: 'done', data: { cancelled: true } })
    await untilIdle(id, 3)
    expect(rt.calls).toEqual(['A', 'B'])
    expect(history(id)).toEqual([['user', 'A'], ['user', 'B'], ['assistant', 're: B']])
  })

  it('after a reload, lists what waits and follows the reply in progress to the end', async () => {
    useRuntime().partials = ['Hel', 'Hello']
    const id = await newConv()
    const a = gate()
    const first = await startHeld(id, 'A', a.promise)
    await enqueue(id, 'B', 'b')
    const listed = await get(`/api/web/conversations/${id}/messages`)
    expect(listed.running).toBe(true)
    expect(listed.queue.map((q: any) => [q.text, q.state])).toEqual([['B', 'queued']])

    // The reloaded page follows: the turn so far first, then what comes next.
    const res = await fetch(`${base()}/api/web/conversations/${id}/stream`, { headers: H() })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = res.text()
    await new Promise((r) => setTimeout(r, 50))
    a.open()
    await (await first).text()
    const evs: Ev[] = parseSse(await text)
    const names = evs.map((e) => e.name)
    // The announcement names the message but never carries its words.
    expect(evs[0]).toMatchObject({ name: 'start', data: { item: { state: 'running' } } })
    expect(evs[0]!.data.item.text).toBeUndefined()
    // What A had said before the page joined arrives as one piece.
    expect(evs.filter((e) => e.name === 'delta').map((e) => e.data.text)[0]).toBe('Hello')
    expect(names.filter((n) => n === 'start')).toHaveLength(2)
    expect(names.filter((n) => n === 'done')).toHaveLength(2)
    expect(names.at(-1)).toBe('idle')
    expect(evs.filter((e) => e.name === 'start').map((e) => e.data.item.clientId)).toEqual(['', 'b'])
    const users = evs.filter((e) => e.name === 'user').map((e) => e.data.message.content)
    expect(users).toEqual(['A', 'B'])
    await bot.turnsIdle()
  })

  it('following an idle conversation says so at once', async () => {
    useRuntime()
    const id = await newConv()
    const evs = parseSse(await (await fetch(`${base()}/api/web/conversations/${id}/stream`, { headers: H() })).text())
    expect(evs).toEqual([{ name: 'idle', data: {} }])
    const listed = await get(`/api/web/conversations/${id}/messages`)
    expect(listed.queue).toEqual([])
    expect(listed.running).toBe(false)
  })

  it('starts a queue a restart left waiting once the page follows', async () => {
    useRuntime()
    const id = await newConv()
    // As the store looks after a restart: one cut off mid-turn, one waiting.
    queue.addItem({ conversationId: id, chatId: '4242', clientId: 'old', text: 'cut off', attachments: [], pastes: [], state: 'running' })
    queue.addItem({ conversationId: id, chatId: '4242', clientId: 'w', text: 'waiting', attachments: [], pastes: [], state: 'queued' })
    const evs = parseSse(await (await fetch(`${base()}/api/web/conversations/${id}/stream`, { headers: H() })).text())
    expect(evs.filter((e) => e.name === 'start').map((e) => e.data.item.clientId)).toEqual(['w'])
    expect(evs.filter((e) => e.name === 'user').map((e) => e.data.message.content)).toEqual(['waiting'])
    expect(evs.at(-1)!.name).toBe('idle')
    expect(rt.calls).toEqual(['waiting'])
  })

  it('a command typed mid-turn waits; /cancel runs at once and stops everything, the queue included', async () => {
    useRuntime()
    const id = await newConv()
    const other = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    const queued = await enqueue(id, '/chatid', 'q1')
    expect(queued.item.state).toBe('queued')
    await enqueue(id, 'B', 'q1b')
    // A message waiting in another chat of the same owner goes too.
    queue.addItem({ conversationId: other, chatId: '4242', clientId: 'q1y', text: 'Y', attachments: [], pastes: [], state: 'queued' })
    const now = await post(`/api/web/conversations/${id}/chat`, { text: '/cancel', clientId: 'q2' })
    expect(now.headers.get('content-type')).toContain('text/event-stream')
    const cancelEvs = parseSse(await now.text())
    const said = cancelEvs.filter((e) => e.name === 'reply').map((e) => e.data.message.content).join(' ')
    expect(said).toContain('Stopping the current reply.')
    expect(said).toContain('Dropped 3 queued messages.')
    expect(parseSse(await (await first).text()).at(-1)).toEqual({ name: 'done', data: { cancelled: true } })
    await bot.turnsIdle()
    await new Promise((r) => setTimeout(r, 50))
    expect(queue.listQueued(id)).toEqual([])
    expect(queue.listQueued(other)).toEqual([])
    expect(rt.calls).toEqual(['A'])
    expect(history(id).map((m) => m[1])).not.toContain('/chatid')
  })

  it('Stop names the reply it means: pressed during the hand-off, it leaves the next message alone', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    rt.gates[0] = a.promise
    const first = post(`/api/web/conversations/${id}/chat`, { text: 'A', clientId: 'ca' })
    await vi.waitFor(() => expect(rt.calls).toHaveLength(1))
    rt.gates[1] = new Promise(() => {})
    const B = (await enqueue(id, 'B', 'cb')).item
    // A ends on the box and B starts at once, but the page still shows A.
    a.open()
    await (await first).text()
    await vi.waitFor(() => expect(rt.calls).toEqual(['A', 'B']))
    const late = (await (await post(`/api/web/conversations/${id}/cancel`, { clientId: 'ca' })).json()) as any
    expect(late).toEqual({ stopped: false, reason: 'finished' })
    const byId = (await (await post(`/api/web/conversations/${id}/cancel`, { itemId: B.id + 1000 })).json()) as any
    expect(byId).toEqual({ stopped: false, reason: 'finished' })
    expect((await get(`/api/web/conversations/${id}/messages`)).running).toBe(true)
    // Naming B stops B.
    const stop = (await (await post(`/api/web/conversations/${id}/cancel`, { itemId: B.id, clientId: 'cb' })).json()) as any
    expect(stop.stopped).toBe(true)
    await untilIdle(id, 3)
    expect(history(id).map((m) => m[1])).toEqual(['A', 're: A', 'B'])
  })

  it('a waiting message that starts while /secret set waits for its key is not taken as the key', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    const b = gate()
    const first = await startHeld(id, 'A', a.promise)
    rt.gates[1] = b.promise
    await enqueue(id, 'also check the invoice', 'cb')
    const ask = parseSse(await (await post(`/api/web/conversations/${id}/chat`, { text: '/secret set FOO_TOKEN', clientId: 's1' })).text())
    expect(ask.filter((e) => e.name === 'reply').map((e) => e.data.message.content).join('')).toContain('Send the key for FOO_TOKEN')
    a.open()
    await (await first).text()
    // The waiting message ran as an ordinary message, and the flow still waits.
    await vi.waitFor(() => expect(rt.calls).toEqual(['A', 'also check the invoice']))
    expect(bot.webSecretAwaited('4242')).toBe(true)
    // The real key, typed now, goes to the flow: never the queue, the history or the agent.
    const key = await post(`/api/web/conversations/${id}/chat`, { text: 'real-key-not-real-789', clientId: 'k1' })
    expect(key.headers.get('content-type')).toContain('text/event-stream')
    expect(parseSse(await key.text()).map((e) => e.name)).toContain('dropped')
    expect(bot.webSecretAwaited('4242')).toBe(false)
    b.open()
    await untilIdle(id, 6)
    expect(rt.calls).toEqual(['A', 'also check the invoice'])
    expect(history(id).map((m) => m[1])).toContain('also check the invoice')
    expect(JSON.stringify(conv.listMessages(id))).not.toContain('real-key-not-real-789')
    expect(JSON.stringify(queue.listAllForTest(id))).not.toContain('real-key-not-real-789')
  })

  it('a retried send of a key, or of /secret, is recognised without keeping the words', async () => {
    useRuntime()
    const id = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    await (await post(`/api/web/conversations/${id}/chat`, { text: '/secret set FOO_TOKEN', clientId: 's1' })).text()
    await (await post(`/api/web/conversations/${id}/chat`, { text: 'retry-key-not-real-1', clientId: 'k1' })).text()
    // The page never saw the answer and sends the same thing again.
    const again = await post(`/api/web/conversations/${id}/chat`, { text: 'retry-key-not-real-1', clientId: 'k1' })
    expect(again.status).toBe(202)
    expect(((await again.json()) as any).item).toMatchObject({ clientId: 'k1', state: 'done', text: '' })
    const inline = { text: '/secret set FOO_TOKEN inline-retry-not-real-2', clientId: 's2' }
    await (await post(`/api/web/conversations/${id}/chat`, inline)).text()
    const again2 = await post(`/api/web/conversations/${id}/chat`, inline)
    expect(again2.status).toBe(202)
    expect(queue.listQueued(id)).toEqual([])
    const rows = JSON.stringify(queue.listAllForTest(id))
    expect(rows).not.toContain('retry-key-not-real-1')
    expect(rows).not.toContain('inline-retry-not-real-2')
    expect(JSON.stringify(conv.listMessages(id))).not.toContain('retry-key-not-real-1')
    expect(rt.calls).toEqual(['A'])
    await post(`/api/web/conversations/${id}/cancel`)
    await (await first).text()
  })

  it('editing a waiting message refuses /secret, /cancel and a pending key, and stores none of them', async () => {
    useRuntime()
    const id = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    const B = (await enqueue(id, 'B', 'b')).item
    const edit = (text: string) => post(`/api/web/conversations/${id}/queue/${B.id}`, { text })
    for (const t of ['/secret set FOO_TOKEN edit-not-real-3', '/cancel', '/steer go left']) {
      const r = await edit(t)
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: 'runs_now' })
    }
    await (await post(`/api/web/conversations/${id}/chat`, { text: '/secret set FOO_TOKEN', clientId: 's1' })).text()
    const key = await edit('pasted-key-not-real-4')
    expect(key.status).toBe(400)
    expect(await key.json()).toEqual({ error: 'runs_now' })
    // A command is still fine to wait.
    expect((await edit('/chatid')).status).toBe(200)
    const rows = JSON.stringify(queue.listAllForTest(id))
    expect(rows).not.toContain('edit-not-real-3')
    expect(rows).not.toContain('pasted-key-not-real-4')
    await (await post(`/api/web/conversations/${id}/chat`, { text: '/secret cancel', clientId: 's2' })).text()
    await post(`/api/web/conversations/${id}/cancel`)
    await (await first).text()
  })

  it('a button click mid-turn claims its card and waits its turn', async () => {
    const r = useRuntime()
    r.buttons = '\n[[buttons: Yes | No]]'
    const id = await newConv()
    const card = parseSse(await (await post(`/api/web/conversations/${id}/chat`, { text: 'ask' })).text()).at(-1)!.data.message
    expect(card.buttons).toEqual(['Yes', 'No'])
    r.buttons = ''
    const a = gate()
    const first = await startHeld(id, 'A', a.promise)
    const click = await enqueue(id, '[button_click]: Yes', 'k')
    expect(click.item.state).toBe('queued')
    // The card is taken: a second tab cannot answer it too.
    const second = await post(`/api/web/conversations/${id}/chat`, { text: '[button_click]: No', clientId: 'k2' })
    expect(second.status).toBe(409)
    // A click is not text to rewrite.
    expect((await post(`/api/web/conversations/${id}/queue/${click.item.id}`, { text: 'hi' })).status).toBe(400)
    a.open()
    await (await first).text()
    await untilIdle(id, 6)
    expect(rt.calls.at(-1)).toBe('[button_click]: Yes')
  })

  it('deleting a conversation drops what waits in it', async () => {
    useRuntime()
    const id = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    await enqueue(id, 'B', 'b')
    expect((await post(`/api/web/conversations/${id}/delete`)).status).toBe(200)
    await (await first).text()
    await bot.turnsIdle()
    expect(queue.listQueued(id)).toEqual([])
    expect(rt.calls).toEqual(['A'])
  })

  it('after the AI limit pauses a reply, the queue waits until the page follows again', async () => {
    const r = useRuntime()
    r.pausedAt.add(0)
    const id = await newConv()
    const a = gate()
    const first = await startHeld(id, 'A', a.promise)
    await enqueue(id, 'B', 'b')
    a.open()
    expect(parseSse(await (await first).text()).at(-1)!.name).toBe('paused')
    await bot.turnsIdle()
    await new Promise((res) => setTimeout(res, 50))
    expect(rt.calls).toEqual(['A'])
    expect(queue.listQueued(id).map((q) => q.text)).toEqual(['B'])
    const evs = parseSse(await (await fetch(`${base()}/api/web/conversations/${id}/stream`, { headers: H() })).text())
    expect(evs.filter((e) => e.name === 'start').map((e) => e.data.item.clientId)).toEqual(['b'])
    expect(rt.calls).toEqual(['A', 'B'])
  })

  it('keeps a message in the store only while it waits, then blanks it', async () => {
    useRuntime()
    const id = await newConv()
    const a = gate()
    const first = await startHeld(id, 'A secret-ish text', a.promise)
    const B = (await enqueue(id, 'B words', 'b')).item
    const rows = () => queue.listAllForTest(id)
    // The running message was never written down; the waiting one is, so a reload can show it.
    expect(rows().map((r) => [r.state, r.text])).toEqual([['running', ''], ['queued', 'B words']])
    a.open()
    await (await first).text()
    await untilIdle(id, 4)
    expect(rows().map((r) => [r.state, r.text, r.pastes, r.attachments])).toEqual([['done', '', [], []], ['done', '', [], []]])
    // A late retry still finds its row, without the words.
    expect((await enqueue(id, 'B words', 'b')).item).toMatchObject({ id: B.id, state: 'done', text: '' })
  })

  it('never queues a key: /secret and the key a pending /secret set waits for run at once', async () => {
    useRuntime()
    const id = await newConv()
    const first = await startHeld(id, 'A', new Promise(() => {}))
    // /secret set typed mid-turn runs at once and waits for the key.
    const askRes = await post(`/api/web/conversations/${id}/chat`, { text: '/secret set FOO_TOKEN', clientId: 's1' })
    expect(askRes.headers.get('content-type')).toContain('text/event-stream')
    const ask = parseSse(await askRes.text())
    expect(ask.filter((e) => e.name === 'reply').map((e) => e.data.message.content).join('')).toContain('Send the key for FOO_TOKEN')
    // The key, typed while A is still running: captured now, never queued or stored.
    const key = await post(`/api/web/conversations/${id}/chat`, { text: 'not-a-real-key-123', clientId: 's2' })
    expect(key.headers.get('content-type')).toContain('text/event-stream')
    expect(parseSse(await key.text()).map((e) => e.name)).toContain('dropped')
    // An inline key mid-turn runs at once too.
    const inline = await post(`/api/web/conversations/${id}/chat`, { text: '/secret set FOO_TOKEN inline-not-real-456', clientId: 's3' })
    expect(inline.headers.get('content-type')).toContain('text/event-stream')
    await inline.text()
    const rows = JSON.stringify(queue.listAllForTest(id))
    expect(rows).not.toContain('not-a-real-key-123')
    expect(rows).not.toContain('inline-not-real-456')
    expect(queue.listQueued(id)).toEqual([])
    expect(JSON.stringify(conv.listMessages(id))).not.toContain('not-a-real-key-123')
    expect(rt.calls).toEqual(['A'])
    await post(`/api/web/conversations/${id}/cancel`)
    await (await first).text()
  })
})
