/**
 * Card #248: the live voice module's side of a call started from the web chat
 * bar. OpenAI's session endpoint and the sideband WebSocket are fakes, so no
 * paid call is made. Covers what the web layer relies on: the chat's messages
 * reach both models, End closes the session over the sideband, and the end
 * hook gets the transcript once, however the call ends.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
  OPENAI_API_KEY: 'sk-test-not-real',
}))
vi.mock('../src/memory/engine.js', () => ({ createDefaultEngine: () => ({ buildContext: async () => '', invalidateCaches: () => {} }) }))

/** A stand-in for the sideband socket: records what is sent, lets the test play OpenAI. */
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 1
  sent: Array<Record<string, unknown>> = []
  private listeners = new Map<string, Array<(e: unknown) => void>>()
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', {})
  }
  emit(type: string, e: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
  event(ev: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(ev) })
  }
}

let live: typeof import('../src/voice-live.js')
const requests: Array<{ url: string; body: any }> = []
let sessionN = 0

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'voice-live-web-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) })
    const id = `sess_fake_${++sessionN}`
    return new Response(JSON.stringify({ session: { id }, transport: { sdp: 'v=0 answer' } }), { status: 200 })
  }))
  live = await import('../src/voice-live.js')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  for (const s of FakeSocket.all) s.close()
  FakeSocket.all = []
  requests.length = 0
})

describe('createLiveSession for a web call', () => {
  it('gives both models the chat, closes on End, and hands the transcript to onEnded once', async () => {
    const ended: import('../src/voice-live.js').EndedCall[] = []
    const result = (await live.createLiveSession('v=0 offer', undefined, '4242', undefined, {
      chatContext: 'User: Draft the dojo newsletter',
      onEnded: (c) => ended.push(c),
    })) as { session: { id: string } }
    const id = result.session.id

    expect(requests[0]!.body.session.instructions).toContain('User: Draft the dojo newsletter')
    const ws = FakeSocket.all[0]!
    expect(ws.url).toContain(encodeURIComponent(id))
    ws.emit('open', {})
    ws.event({ type: 'session.input_transcript.delta', delta: 'Make it shorter please', start_ms: 100, end_ms: 900 })
    ws.event({ type: 'session.output_transcript.delta', delta: 'Done, it is half the length.', start_ms: 2000, end_ms: 3000 })

    // End from the web: only the chat that opened it can.
    expect(live.endLiveSession(id, '9999')).toBe(false)
    expect(live.endLiveSession(id, '4242')).toBe(true)
    expect(ws.sent.at(-1)).toEqual({ type: 'session.close' })

    // OpenAI confirms; the socket then closes. The hook runs once.
    ws.event({ type: 'session.closed', usage: { seconds: 42 } })
    expect(ended).toHaveLength(1)
    expect(ended[0]!.sessionId).toBe(id)
    expect(ended[0]!.billedSeconds).toBe(42)
    expect(ended[0]!.turns.map((t) => [t.who, t.text])).toEqual([
      ['user', 'Make it shorter please'],
      ['assistant', 'Done, it is half the length.'],
    ])
    expect(live.liveStatus().active).toBe(0)
  })

  it('a dropped sideband still ends the call and runs the hook', async () => {
    const ended: unknown[] = []
    await live.createLiveSession('v=0 offer', undefined, '4242', undefined, { onEnded: (c) => ended.push(c) })
    FakeSocket.all[0]!.close()
    expect(ended).toHaveLength(1)
  })

  it('a call from the voice page (no options) is unchanged', async () => {
    await live.createLiveSession('v=0 offer', undefined, '4242')
    expect(requests[0]!.body.session.instructions).not.toContain('started from a chat in the web app')
  })
})
