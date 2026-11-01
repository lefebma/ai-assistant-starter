/**
 * Card #248: voice chat from the web chat bar. The routes start and end a
 * live voice call with the web session as the credential, and a finished
 * call's transcript lands in the conversation as voice messages. The live
 * session is stubbed, so no paid call is made.
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
import type { VoiceChatDeps, VoiceChatStart } from '../src/web/voice-chat.js'
import type { EndedCall, Turn } from '../src/voice-live.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  calls: AgentRunOptions[] = []
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options)
    return { text: 'noted', newSessionId: 'sess-1' }
  }
  async runOnce(): Promise<string> { return 'once' }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> { return new Map() }
}

let port = 0
let server: typeof import('../src/http-server.js')
let sessions: typeof import('../src/web/sessions.js')
let conv: typeof import('../src/web/conversations.js')
let voice: typeof import('../src/web/voice-chat.js')
let runtimeMod: typeof import('../src/runtime/index.js')
let bot: typeof import('../src/bot.js')
let cookie = ''
let otherCookie = ''

/** The stub live session: what it was asked, and the hooks to end it later. */
const live = {
  block: '' as import('../src/web/voice-chat.js').VoiceChatBlock,
  started: [] as VoiceChatStart[],
  ended: [] as Array<{ sessionId: string; chatId: string }>,
  fail: null as Error | null,
  /** When set, start waits on it, so two starts can overlap. */
  gate: null as Promise<void> | null,
  /** When set, start answers with a session id and no SDP. */
  noSdp: false,
  cancelled: [] as string[],
  runs: 0,
  next: 1,
  /** What the call "said", filed when it is ended. */
  turns: [] as Turn[],
  startedAt: new Date('2026-10-26T15:00:00Z'),
}
const open = new Map<string, VoiceChatStart>()

function finishCall(sessionId: string): void {
  const s = open.get(sessionId)
  if (!s) return
  open.delete(sessionId)
  const ended: EndedCall = { sessionId, startedAt: live.startedAt, endedAt: new Date(), turns: live.turns }
  s.onEnded(ended)
}

const stub: VoiceChatDeps = {
  block: () => live.block,
  async start(input) {
    if (live.fail) throw live.fail
    live.started.push(input)
    const id = `sess_live_${live.next++}`
    if (live.gate) await live.gate
    open.set(id, input)
    if (live.noSdp) return { session: { id } }
    return {
      session: { id, instructions: 'SECRET INSTRUCTIONS' } as { id: string },
      transport: { sdp: 'v=0 answer' },
    }
  },
  end(sessionId, chatId) {
    live.ended.push({ sessionId, chatId })
    // OpenAI closes the session; the sideband sees session.closed a moment later.
    setTimeout(() => finishCall(sessionId), 20)
    return true
  },
  cancel(chatId) {
    live.cancelled.push(chatId)
    let calls = 0
    for (const [id, s] of open) {
      if (s.chatId !== chatId) continue
      calls++
      setTimeout(() => finishCall(id), 20)
    }
    return { calls, runs: live.runs }
  },
}

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-voice-chat-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  db.addAuthorizedChat('5555', 'other', '4242')
  sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  voice = await import('../src/web/voice-chat.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  voice.setVoiceChatDepsForTest(stub)
  // Band 5720-5739.
  port = 5720 + Math.floor(Math.random() * 20)
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
  otherCookie = sessionFor('5555')
})

afterAll(async () => {
  voice.setVoiceChatDepsForTest(null)
  runtimeMod.setAgentRuntime(null)
  await server.stopHttpServer()
})

afterEach(async () => {
  await bot.turnsIdle()
  for (const id of [...open.keys()]) finishCall(id)
  live.block = ''
  live.started = []
  live.ended = []
  live.fail = null
  live.turns = []
  live.gate = null
  live.noSdp = false
  live.cancelled = []
  live.runs = 0
})

function sessionFor(chatId: string): string {
  const { token } = sessions.mintWebLink(chatId)
  return `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
}
const base = () => `http://127.0.0.1:${port}`
const post = (path: string, body: unknown, c: string | null = cookie) =>
  fetch(base() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c } : {}) },
    body: JSON.stringify(body),
  })
const me = async (c = cookie) => (await (await fetch(base() + '/api/web/me', { headers: { Cookie: c } })).json()) as Record<string, unknown>
const turn = (who: Turn['who'], text: string, start_ms: number): Turn => ({ who, text, start_ms, end_ms: start_ms + 500 })

describe('voice chat capability flag', () => {
  it('/api/web/me says whether the chat bar may start a call', async () => {
    expect((await me()).voiceChat).toBe(true)
    live.block = 'not_configured'
    expect((await me()).voiceChat).toBe(false)
    live.block = 'managed_ai'
    expect((await me()).voiceChat).toBe(false)
  })

  it('by default it follows the OpenAI key, the managed-AI rule and the Node version', async () => {
    const cfg = await import('../src/config.js')
    const { isManagedAi } = await import('../src/ai-limit.js')
    const { liveRuntimeSupported } = await import('../src/voice-live.js')
    voice.setVoiceChatDepsForTest(null)
    try {
      expect((await me()).voiceChat).toBe(!isManagedAi() && !!cfg.OPENAI_API_KEY && liveRuntimeSupported())
    } finally {
      voice.setVoiceChatDepsForTest(stub)
    }
  })
})

describe('voice dropdown (card #257)', () => {
  it('/api/web/me lists LIVE_VOICES and a default that is one of them', async () => {
    const { LIVE_VOICES } = await import('../src/voice-live.js')
    const m = await me()
    expect(m.voices).toEqual([...LIVE_VOICES])
    expect(LIVE_VOICES as readonly string[]).toContain(m.defaultVoice)
  })

  it('passes a listed voice through and refuses an unlisted one', async () => {
    const c = conv.createConversation('4242', '')
    const bad = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer', voice: 'nope' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_voice' })
    expect(live.started).toHaveLength(0)
    const num = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer', voice: 7 })
    expect(num.status).toBe(400)
    const ok = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer', voice: 'willow' })
    expect(ok.status).toBe(201)
    expect(live.started[0]!.voice).toBe('willow')
  })
})

describe('POST /api/web/conversations/:id/voice', () => {
  it('refuses a caller with no session', async () => {
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' }, null)
    expect(r.status).toBe(401)
    expect(live.started).toHaveLength(0)
  })

  it("does not find another chat's conversation", async () => {
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' }, otherCookie)
    expect(r.status).toBe(404)
    expect(live.started).toHaveLength(0)
  })

  it('refuses a revoked chat even with a session', async () => {
    const db = await import('../src/db.js')
    db.addAuthorizedChat('6666', 'gone soon', '4242')
    const c6 = sessionFor('6666')
    const c = conv.createConversation('6666', '')
    db.removeAuthorizedChat('6666')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' }, c6)
    expect(r.status).toBe(401)
    expect(live.started).toHaveLength(0)
  })

  it('answers 503 with the reason when the box cannot do live voice', async () => {
    live.block = 'not_configured'
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'not_configured' })
    expect(live.started).toHaveLength(0)
  })

  it('needs an offer', async () => {
    const c = conv.createConversation('4242', '')
    expect((await post(`/api/web/conversations/${c.id}/voice`, {})).status).toBe(400)
    expect((await post(`/api/web/conversations/${c.id}/voice`, { sdp: '  ' })).status).toBe(400)
  })

  it('starts a call with the chat as context and returns only the session id and the answer', async () => {
    const c = conv.createConversation('4242', '')
    conv.addMessage(c.id, 'user', 'Draft a note to Gus about the invoice')
    conv.addMessage(c.id, 'assistant', 'Here is the draft: Hi Gus, the invoice is attached.')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer', voice: 'willow' })
    expect(r.status).toBe(201)
    const body = (await r.json()) as Record<string, unknown>
    expect(body).toEqual({ sessionId: expect.stringMatching(/^sess_live_/), sdp: 'v=0 answer' })
    expect(JSON.stringify(body)).not.toContain('SECRET')
    expect(live.started).toHaveLength(1)
    const s = live.started[0]!
    expect(s.chatId).toBe('4242')
    expect(s.sdp).toBe('v=0 offer')
    expect(s.voice).toBe('willow')
    expect(s.chatContext).toBe('User: Draft a note to Gus about the invoice\nAssistant: Here is the draft: Hi Gus, the invoice is attached.')
  })

  it('allows one call at a time in a conversation', async () => {
    const c = conv.createConversation('4242', '')
    expect((await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).status).toBe(201)
    const again = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'call_active' })
  })

  it('passes on the live voice module refusals', async () => {
    const { LiveSessionError } = await import('../src/voice-live.js')
    live.fail = new LiveSessionError(429, 'too_many_sessions')
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'too_many_sessions' })
  })
})

describe('final review fixes (I1, I2, I3, m3, m8)', () => {
  it('two starts at once in a conversation open one call; the other gets 409 (I1)', async () => {
    const c = conv.createConversation('4242', '')
    let go!: () => void
    live.gate = new Promise<void>((r) => (go = r))
    const a = post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    const b = post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    await vi.waitFor(() => expect(live.started.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    go()
    const statuses = [(await a).status, (await b).status].sort()
    expect(statuses).toEqual([201, 409])
    expect(live.started).toHaveLength(1)
  })

  it('a start that fails gives the conversation back for the next try', async () => {
    const { LiveSessionError } = await import('../src/voice-live.js')
    const c = conv.createConversation('4242', '')
    live.fail = new LiveSessionError(502, 'upstream_failed')
    expect((await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).status).toBe(502)
    live.fail = null
    expect((await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).status).toBe(201)
  })

  it('a session that comes back with no answer is ended on the box (m3)', async () => {
    const c = conv.createConversation('4242', '')
    live.noSdp = true
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    expect(r.status).toBe(502)
    expect(live.ended).toEqual([{ sessionId: 'sess_live_' + (live.next - 1), chatId: '4242' }])
  })

  it('the page can ask whether its call is still open, and learns when the box ended it (I2)', async () => {
    const c = conv.createConversation('4242', '')
    const { sessionId } = (await (await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).json()) as { sessionId: string }
    const status = (ck = cookie) => fetch(`${base()}/api/web/voice/calls/${sessionId}`, { headers: ck ? { Cookie: ck } : {} })
    expect(await (await status()).json()).toEqual({ finished: false, added: 0 })
    expect((await status(otherCookie)).status).toBe(404)
    expect((await status('')).status).toBe(401)
    live.turns = [turn('user', 'Are you still there?', 0)]
    finishCall(sessionId) // the box ended it: idle, too long, or its line to the voice service dropped
    expect(await (await status()).json()).toEqual({ finished: true, added: 1 })
    expect((await fetch(`${base()}/api/web/voice/calls/sess_nope`, { headers: { Cookie: cookie } })).status).toBe(404)
  })

  it('/cancel typed in the web chat ends the call and stops its lookups (I3)', async () => {
    const c = conv.createConversation('4242', '')
    const { sessionId } = (await (await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).json()) as { sessionId: string }
    live.runs = 1
    const said = await (await post(`/api/web/conversations/${c.id}/chat`, { text: '/cancel' })).text()
    expect(live.cancelled).toEqual(['4242'])
    expect(said).toContain('Ended the voice call.')
    expect(said).toContain('Stopped 1 lookup the call started.')
    await vi.waitFor(() => expect(open.has(sessionId)).toBe(false))
  })

  it('/cancel during a start ends that call as soon as it exists', async () => {
    const c = conv.createConversation('4242', '')
    let go!: () => void
    live.gate = new Promise<void>((r) => (go = r))
    const starting = post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    await vi.waitFor(() => expect(live.started).toHaveLength(1))
    voice.cancelVoiceForChat('4242')
    go()
    const r = await starting
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'call_ended' })
    expect(live.ended).toHaveLength(1)
  })

  it('signing the chat out of the web app ends the calls its pages opened (m8)', async () => {
    const c = conv.createConversation('4242', '')
    const { sessionId } = (await (await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })).json()) as { sessionId: string }
    sessions.revokeAllWebSessions('4242')
    expect(live.ended).toEqual([{ sessionId, chatId: '4242' }])
    cookie = sessionFor('4242')
  })
})

describe('POST /api/web/voice/end', () => {
  async function startCall(): Promise<{ convId: string; sessionId: string }> {
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    return { convId: c.id, sessionId: ((await r.json()) as { sessionId: string }).sessionId }
  }

  it('refuses a caller with no session, and another chat, without ending the call', async () => {
    const { sessionId } = await startCall()
    expect((await post('/api/web/voice/end', { sessionId }, null)).status).toBe(401)
    expect((await post('/api/web/voice/end', { sessionId }, otherCookie)).status).toBe(404)
    expect(live.ended).toHaveLength(0)
  })

  it('answers 404 for a call it does not know', async () => {
    expect((await post('/api/web/voice/end', { sessionId: 'sess_nope' })).status).toBe(404)
    expect((await post('/api/web/voice/end', {})).status).toBe(404)
  })

  it('ends the session, waits for the transcript, and files it as voice messages', async () => {
    const { convId, sessionId } = await startCall()
    live.turns = [
      turn('assistant', 'Hey, what is up?', 0),
      turn('user', 'What is on my calendar tomorrow?', 3000),
      turn('user', 'Just the morning.', 6000),
      turn('assistant', 'Two meetings, at nine and at eleven.', 9000),
    ]
    const r = await post('/api/web/voice/end', { sessionId, wait: true })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ended: true, finished: true, added: 3 })
    expect(live.ended).toEqual([{ sessionId, chatId: '4242' }])
    const page = (await (await fetch(`${base()}/api/web/conversations/${convId}/messages`, { headers: { Cookie: cookie } })).json()) as {
      messages: Array<{ role: string; content: string; voice?: boolean }>
    }
    expect(page.messages.map((m) => [m.role, m.content, m.voice])).toEqual([
      ['assistant', 'Hey, what is up?', true],
      ['user', 'What is on my calendar tomorrow? Just the morning.', true],
      ['assistant', 'Two meetings, at nine and at eleven.', true],
    ])
    // A second End (the page going away afterwards) closes nothing again.
    expect(await (await post('/api/web/voice/end', { sessionId })).json()).toEqual({ ended: true, finished: true, added: 3 })
    expect(live.ended).toHaveLength(1)
  })

  it('a call that ends on its own (idle, too long, hung up) is filed too, and a new one can start', async () => {
    const { convId, sessionId } = await startCall()
    live.turns = [turn('user', 'Remind me to call the dojo', 1000), turn('assistant', 'Done.', 2000)]
    finishCall(sessionId)
    expect(conv.listMessages(convId).filter((m) => m.voice)).toHaveLength(2)
    expect((await post(`/api/web/conversations/${convId}/voice`, { sdp: 'v=0 offer' })).status).toBe(201)
  })

  it('adds nothing when the user never spoke', async () => {
    const { convId, sessionId } = await startCall()
    live.turns = [turn('assistant', 'Hi there.', 0)]
    expect(await (await post('/api/web/voice/end', { sessionId, wait: true })).json()).toEqual({ ended: true, finished: true, added: 0 })
    expect(conv.listMessages(convId)).toHaveLength(0)
  })

  it('details sent to the chat during the call sit where they were said', async () => {
    const { convId, sessionId } = await startCall()
    const s = live.started[0]!
    live.startedAt = new Date(Date.now() - 10_000)
    live.turns = [
      turn('user', 'List my open invoices.', 1000),
      turn('assistant', 'Three are open. The details are in your chat.', 9_500),
    ]
    // Delivered about four seconds in: after the question, before the answer.
    vi.setSystemTime(live.startedAt.getTime() + 4000)
    await s.deliver('Invoice 12, $400\nInvoice 13, $250\nInvoice 14, $90')
    vi.useRealTimers()
    await post('/api/web/voice/end', { sessionId, wait: true })
    expect(conv.listMessages(convId).map((m) => m.content)).toEqual([
      'List my open invoices.',
      'Invoice 12, $400\nInvoice 13, $250\nInvoice 14, $90',
      'Three are open. The details are in your chat.',
    ])
    live.startedAt = new Date('2026-10-26T15:00:00Z')
  })

  it('a lookup that outlives the call still reaches the conversation', async () => {
    const { convId, sessionId } = await startCall()
    const s = live.started[0]!
    live.turns = [turn('user', 'Find the Silverts proposal', 0)]
    await post('/api/web/voice/end', { sessionId, wait: true })
    expect(await s.deliver('From your call:\n\nFound it in the projects folder.')).toBe(true)
    const last = conv.listMessages(convId).at(-1)!
    expect([last.role, last.content, last.voice]).toEqual(['assistant', 'From your call:\n\nFound it in the projects folder.', true])
  })

  it('deleting the conversation ends its call and files nothing', async () => {
    const { convId, sessionId } = await startCall()
    live.turns = [turn('user', 'Something worth keeping', 0)]
    expect((await post(`/api/web/conversations/${convId}/delete`, {})).status).toBe(200)
    expect(live.ended).toEqual([{ sessionId, chatId: '4242' }])
    await vi.waitFor(() => expect(open.has(sessionId)).toBe(false))
    expect(conv.listMessages(convId)).toHaveLength(0)
  })
})

describe('the next typed turn hears about the call', () => {
  it('tells the agent once what was said on a call since the last typed message', async () => {
    const rt = new FakeRuntime()
    runtimeMod.setAgentRuntime(rt)
    const c = conv.createConversation('4242', '')
    const r = await post(`/api/web/conversations/${c.id}/voice`, { sdp: 'v=0 offer' })
    const { sessionId } = (await r.json()) as { sessionId: string }
    live.turns = [turn('user', 'Book the dojo hall for Saturday', 0), turn('assistant', 'Booked for ten.', 1500)]
    await post('/api/web/voice/end', { sessionId, wait: true })

    await (await post(`/api/web/conversations/${c.id}/chat`, { text: 'Add it to my calendar too' })).text()
    expect(rt.calls).toHaveLength(1)
    const prompt = rt.calls[0]!.message
    expect(prompt).toContain('this chat had a voice call')
    expect(prompt).toContain('User: Book the dojo hall for Saturday\nAssistant: Booked for ten.')
    expect(prompt.indexOf('Booked for ten.')).toBeLessThan(prompt.indexOf('Add it to my calendar too'))

    await (await post(`/api/web/conversations/${c.id}/chat`, { text: 'Thanks' })).text()
    expect(rt.calls[1]!.message).not.toContain('voice call')
  })
})

describe('mapping helpers', () => {
  it('callMessages merges a speaker in a row and drops empty turns', () => {
    expect(
      voice.callMessages(
        [turn('user', 'one', 0), turn('user', ' two ', 2000), turn('assistant', '  ', 3000), turn('assistant', 'three', 4000)],
        0,
      ),
    ).toEqual([
      { role: 'user', content: 'one two' },
      { role: 'assistant', content: 'three' },
    ])
    expect(voice.callMessages([turn('assistant', 'Hello?', 0)], 0)).toEqual([])
    expect(voice.callMessages([], 0)).toEqual([])
  })

  it('callMessages keeps a delivery apart from the spoken turns around it', () => {
    expect(
      voice.callMessages([turn('assistant', 'Checking.', 1000), turn('assistant', 'Sent you the list.', 5000), turn('user', 'ok', 6000)], 100_000, [
        { at: 103_000, text: 'the list' },
      ]),
    ).toEqual([
      { role: 'assistant', content: 'Checking.' },
      { role: 'assistant', content: 'the list' },
      { role: 'assistant', content: 'Sent you the list.' },
      { role: 'user', content: 'ok' },
    ])
  })

  it('chatContextFor keeps the latest messages, shortened', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }))
    const ctx = voice.chatContextFor(many)
    expect(ctx.split('\n')).toHaveLength(12)
    expect(ctx.startsWith('User: m8')).toBe(true)
    const long = voice.chatContextFor([{ role: 'user', content: 'x'.repeat(1000) }])
    expect(long.length).toBeLessThan(420)
    expect(voice.chatContextFor([])).toBe('')
  })

  it('voiceNoteFor covers only the call since the previous typed message', () => {
    const m = (role: 'user' | 'assistant', content: string, v = false) => ({ role, content, voice: v })
    expect(voice.voiceNoteFor([m('user', 'hi')])).toBe('')
    const note = voice.voiceNoteFor([m('user', 'a'), m('assistant', 'b'), m('user', 'said', true), m('assistant', 'heard', true), m('user', 'now')])
    expect(note).toContain('User: said\nAssistant: heard')
    expect(voice.voiceNoteFor([m('user', 'said', true), m('assistant', 'heard', true), m('user', 'now'), m('assistant', 'ok'), m('user', 'next')])).toBe('')
    // A typed reply that landed after the call does not hide it.
    expect(voice.voiceNoteFor([m('user', 'a'), m('user', 'said', true), m('assistant', 'b'), m('user', 'now')])).toContain('User: said')
  })
})
