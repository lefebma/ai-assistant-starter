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
  /** What a new socket starts as: 1 is open, 0 is still connecting. */
  static startState = 1
  readyState = FakeSocket.startState
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
/** When set, session creates wait on it, so starts can overlap. */
let fetchGate: Promise<void> | null = null

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'voice-live-web-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) })
    if (fetchGate) await fetchGate
    const id = `sess_fake_${++sessionN}`
    return new Response(JSON.stringify({ session: { id }, transport: { sdp: 'v=0 answer' } }), { status: 200 })
  }))
  live = await import('../src/voice-live.js')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.useRealTimers()
  FakeSocket.startState = 1
  for (const s of FakeSocket.all) s.close()
  FakeSocket.all = []
  requests.length = 0
  fetchGate = null
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

describe('a call the box can no longer hear (final review I1, I2, I3)', () => {
  it('starts that arrive together cannot open more sessions than the box allows', async () => {
    let open!: () => void
    fetchGate = new Promise<void>((r) => (open = r))
    const starts = [1, 2, 3].map(() => live.createLiveSession('v=0 offer', undefined, '4242').then(() => 'ok', (e) => e.code))
    open()
    const got = await Promise.all(starts)
    expect(got.filter((g) => g === 'ok')).toHaveLength(2)
    expect(got.filter((g) => g === 'too_many_sessions')).toHaveLength(1)
    expect(requests).toHaveLength(2)
  })

  it('a failed create gives its slot back', async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    try {
      for (let i = 0; i < 3; i++) await expect(live.createLiveSession('v=0 offer', undefined, '4242')).rejects.toThrow('upstream_failed')
    } finally {
      vi.stubGlobal('fetch', realFetch)
    }
    await live.createLiveSession('v=0 offer', undefined, '4242')
    expect(live.liveStatus().active).toBe(1)
  })

  it('a sideband that drops mid-call ends the session over a new one, files the call and frees the slot', async () => {
    const ended: import('../src/voice-live.js').EndedCall[] = []
    await live.createLiveSession('v=0 offer', undefined, '4242', undefined, { onEnded: (c) => ended.push(c) })
    const ws = FakeSocket.all[0]!
    ws.emit('open', {})
    ws.event({ type: 'session.input_transcript.delta', delta: 'Before the drop', start_ms: 0, end_ms: 500 })
    ws.close()
    expect(ended).toHaveLength(1)
    expect(ended[0]!.turns.map((t) => t.text)).toEqual(['Before the drop'])
    expect(live.liveStatus().active).toBe(0)
    const again = FakeSocket.all[1]!
    expect(again.url).toBe(ws.url)
    again.emit('open', {})
    expect(again.sent).toEqual([{ type: 'session.close' }])
  })

  it('a sideband that never connects is given up on: the session is ended and the slot freed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    FakeSocket.startState = 0
    const ended: unknown[] = []
    await live.createLiveSession('v=0 offer', undefined, '4242', undefined, { onEnded: (c) => ended.push(c) })
    await live.createLiveSession('v=0 offer', undefined, '4242')
    expect(live.liveStatus().active).toBe(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ended).toHaveLength(1)
    expect(live.liveStatus().active).toBe(0)
    // Each tried to end its session over a fresh sideband.
    expect(FakeSocket.all.filter((s) => s.url.endsWith('/attach'))).toHaveLength(4)
  })

  it('End with the sideband stuck connecting still lets the call go at once', async () => {
    FakeSocket.startState = 0
    const ended: unknown[] = []
    const r = (await live.createLiveSession('v=0 offer', undefined, '4242', undefined, { onEnded: (c) => ended.push(c) })) as { session: { id: string } }
    expect(live.endLiveSession(r.session.id, '4242')).toBe(true)
    expect(ended).toHaveLength(1)
    expect(live.liveStatus().active).toBe(0)
  })

  it('End that OpenAI never confirms still frees the slot after a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const ended: unknown[] = []
    const r = (await live.createLiveSession('v=0 offer', undefined, '4242', undefined, { onEnded: (c) => ended.push(c) })) as { session: { id: string } }
    FakeSocket.all[0]!.emit('open', {})
    live.endLiveSession(r.session.id, '4242')
    expect(FakeSocket.all[0]!.sent.at(-1)).toEqual({ type: 'session.close' })
    expect(live.liveStatus().active).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ended).toHaveLength(1)
    expect(live.liveStatus().active).toBe(0)
  })

  it("/cancel ends this chat's calls and stops the lookups they handed off, and leaves other chats alone", async () => {
    const { setAgentRuntime } = await import('../src/runtime/index.js')
    const signals: AbortSignal[] = []
    setAgentRuntime({
      id: 'fake',
      async run(o: { signal?: AbortSignal }) {
        signals.push(o.signal!)
        return new Promise((resolve) => o.signal!.addEventListener('abort', () => resolve({ text: null, newSessionId: undefined }), { once: true }))
      },
      async runOnce() { return '' },
      steer() {},
      getActiveWorkspaces: () => new Map(),
    } as never)
    try {
      const mine = (await live.createLiveSession('v=0 offer', undefined, '4242')) as { session: { id: string } }
      await live.createLiveSession('v=0 offer', undefined, '5555')
      const ws = FakeSocket.all[0]!
      const other = FakeSocket.all[1]!
      ws.emit('open', {})
      other.emit('open', {})
      ws.event({ type: 'session.input_transcript.delta', delta: 'Clean up my inbox', start_ms: 0, end_ms: 500 })
      ws.event({ type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } })
      await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: 3000 })

      expect(live.cancelLiveForChat('4242')).toEqual({ calls: 1, runs: 1 })
      expect(signals[0]!.aborted).toBe(true)
      expect(ws.sent.at(-1)).toEqual({ type: 'session.close' })
      expect(other.sent.some((e) => e.type === 'session.close')).toBe(false)
      ws.event({ type: 'session.closed', usage: { seconds: 5 } })
      expect(live.endLiveSession(mine.session.id, '4242')).toBe(false)
      expect(live.cancelLiveForChat('4242')).toEqual({ calls: 0, runs: 0 })
    } finally {
      setAgentRuntime(null)
    }
  })
})
