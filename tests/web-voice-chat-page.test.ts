/**
 * The page side of card #248: whether the browser can make a call, the
 * plain-language problems, and a whole call driven with stand-ins for the
 * microphone, WebRTC and the box. No real call is made.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import { voiceCallSupport, callProblem, createVoiceCall, START_TIMEOUT_MS, STATUS_POLL_MS, MAX_CALL_MS, SILENCE_MS, END_RETRY_MS, END_RETRY_FOR_MS } from '../public/app/voicecall.js'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import * as api from '../public/app/api.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const html = readFileSync(join(APP, 'index.html'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class FakeTrack {
  stopped = false
  stop() { this.stopped = true }
}
class FakeChannel {
  sent: string[] = []
  closed = false
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true }
  event(ev: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(ev) }) }
}
class FakePeer {
  static last: FakePeer | null = null
  channel = new FakeChannel()
  tracks: unknown[] = []
  closed = false
  remote: unknown = null
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  ontrack: ((e: unknown) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  constructor() { FakePeer.last = this }
  addTrack(t: unknown) { this.tracks.push(t) }
  createDataChannel() { return this.channel }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' } }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d }
  async setRemoteDescription(d: unknown) { this.remote = d }
  close() { this.closed = true }
}

function rig(opts: { deny?: string; startFails?: unknown; status?: () => Promise<unknown>; startGate?: Promise<void>; end?: () => Promise<unknown> } = {}) {
  const track = new FakeTrack()
  const ended: Array<{ why: string; result: unknown }> = []
  const caught: unknown[] = []
  const captions: string[] = []
  const box = { started: [] as string[], ends: [] as Array<{ id: string; opts: unknown }> }
  const audio = { srcObject: null as unknown, play: vi.fn(async () => {}) }
  const call = createVoiceCall(
    {
      async getUserMedia() {
        if (opts.deny) throw Object.assign(new Error('denied'), { name: opts.deny })
        return { getTracks: () => [track], getAudioTracks: () => [track] }
      },
      RTCPeerConnection: FakePeer,
      MediaStream: class { constructor(public t: unknown[]) {} },
      audio,
      async startSession(sdp: string) {
        box.started.push(sdp)
        if (opts.startGate) await opts.startGate
        if (opts.startFails) throw opts.startFails
        return { sessionId: 'sess_1', sdp: 'v=0 answer' }
      },
      async endSession(id: string, o: unknown) {
        box.ends.push({ id, opts: o })
        if (opts.end) return opts.end()
        return { ended: true, finished: true, added: 2 }
      },
      ...(opts.status ? { callStatus: opts.status } : {}),
    },
    {
      live: vi.fn(),
      caption: (who: string, d: string) => captions.push(`${who}:${d}`),
      working: vi.fn(),
      ended: (why: string, result: unknown) => ended.push({ why, result }),
      caughtUp: (result: unknown) => caught.push(result),
    },
  )
  return { call, track, ended, caught, captions, box, audio }
}

describe('voiceCallSupport', () => {
  const ok = { isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } }, RTCPeerConnection: function () {} }
  it('needs https, a microphone API and WebRTC', () => {
    expect(voiceCallSupport(ok)).toBe('')
    expect(voiceCallSupport({ ...ok, isSecureContext: false })).toBe('insecure')
    expect(voiceCallSupport({ ...ok, navigator: {} })).toBe('unsupported')
    expect(voiceCallSupport({ ...ok, RTCPeerConnection: undefined })).toBe('unsupported')
  })
})

describe('callProblem', () => {
  it('says plainly what went wrong', () => {
    expect(callProblem('insecure')).toMatch(/https/)
    expect(callProblem('unsupported')).toMatch(/browser cannot make voice calls/)
    expect(callProblem({ name: 'NotAllowedError' })).toMatch(/microphone is blocked/)
    expect(callProblem({ name: 'NotFoundError' })).toMatch(/No microphone/)
    expect(callProblem({ name: 'NotReadableError' })).toMatch(/busy in another app/)
    expect(callProblem({ status: 503, code: 'not_configured' })).toMatch(/not set up/)
    expect(callProblem({ status: 429 })).toMatch(/already open on this assistant/)
    expect(callProblem({ status: 409, code: 'call_active' })).toMatch(/already open in this chat/)
    expect(callProblem({ status: 409, code: 'call_ended' })).toMatch(/stopped before it connected/)
    expect(callProblem({ status: 502 })).toMatch(/voice service/)
    expect(callProblem({ name: 'TypeError' })).toMatch(/connection/)
    expect(callProblem(new Error('x'))).toBe('The voice call did not work. Try again.')
  })
})

describe('createVoiceCall', () => {
  it('connects, shows captions, mutes, and End waits for the box to file the transcript', async () => {
    const r = rig()
    await r.call.start()
    const peer = FakePeer.last!
    expect(r.box.started).toEqual(['v=0 offer'])
    expect(peer.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' })
    expect(r.call.phase).toBe('connecting')
    peer.channel.event({ type: 'session.started' })
    expect(r.call.phase).toBe('live')
    peer.channel.event({ type: 'session.input_transcript.delta', delta: 'hello' })
    peer.channel.event({ type: 'session.output_transcript.delta', delta: 'hi there' })
    expect(r.captions).toEqual(['user:hello', 'assistant:hi there'])
    peer.channel.event({ type: 'session.delegation.created' })
    expect(r.call.pending).toBe(1)
    peer.channel.event({ type: 'session.commentary.appended' })
    expect(r.call.pending).toBe(0)

    r.call.mute(true)
    expect(JSON.parse(peer.channel.sent.at(-1)!)).toEqual({ type: 'session.input_audio.mute' })
    expect(r.call.muted).toBe(true)

    await r.call.stop()
    expect(r.box.ends).toEqual([{ id: 'sess_1', opts: { wait: true } }])
    expect(r.ended).toEqual([{ why: 'stopped', result: { ended: true, finished: true, added: 2 } }])
    expect(r.track.stopped).toBe(true)
    expect(peer.closed).toBe(true)
    expect(r.call.phase).toBe('')
    // Ended once: a late session.closed changes nothing.
    await r.call.stop()
    expect(r.ended).toHaveLength(1)
  })

  it('a call the box closes (idle, too long) ends and asks for the transcript', async () => {
    const r = rig()
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    FakePeer.last!.channel.event({ type: 'session.closed', usage: { seconds: 300 } })
    await vi.waitFor(() => expect(r.ended).toHaveLength(1))
    expect(r.ended[0]!.why).toBe('closed')
    expect(r.box.ends).toHaveLength(1)
  })

  it('a dropped connection ends the session on the box too', async () => {
    const r = rig()
    await r.call.start()
    const peer = FakePeer.last!
    peer.channel.event({ type: 'session.started' })
    peer.connectionState = 'failed'
    peer.onconnectionstatechange!()
    await vi.waitFor(() => expect(r.ended).toHaveLength(1))
    expect(r.ended[0]!.why).toBe('lost')
    expect(r.box.ends).toEqual([{ id: 'sess_1', opts: { wait: true } }])
  })

  it('a drop while this page is offline gets the transcript once the box is reachable again', async () => {
    vi.useFakeTimers()
    let online = false
    const r = rig({
      end: async () => {
        if (!online) throw new TypeError('Failed to fetch')
        return { ended: true, finished: true, added: 13 }
      },
    })
    await r.call.start()
    const peer = FakePeer.last!
    peer.channel.event({ type: 'session.started' })
    peer.connectionState = 'disconnected'
    peer.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.ended).toEqual([{ why: 'lost', result: null }])
    await vi.advanceTimersByTimeAsync(END_RETRY_MS * 3)
    expect(r.caught).toEqual([])
    online = true
    await vi.advanceTimersByTimeAsync(END_RETRY_MS)
    expect(r.caught).toEqual([{ ended: true, finished: true, added: 13 }])
    const asked = r.box.ends.length
    await vi.advanceTimersByTimeAsync(END_RETRY_MS * 5)
    expect(r.box.ends).toHaveLength(asked)
  })

  it('keeps asking while the box is still filing the transcript, and gives up after a while', async () => {
    vi.useFakeTimers()
    const r = rig({ end: async () => ({ ended: true, finished: false, added: 0 }) })
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    await r.call.stop()
    expect(r.ended).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(END_RETRY_FOR_MS + END_RETRY_MS * 2)
    expect(r.caught).toEqual([null])
    const asked = r.box.ends.length
    expect(asked).toBeGreaterThan(2)
    await vi.advanceTimersByTimeAsync(END_RETRY_MS * 5)
    expect(r.box.ends).toHaveLength(asked)
  })

  it('stops asking when the box no longer knows the call', async () => {
    vi.useFakeTimers()
    let n = 0
    const r = rig({
      end: async () => {
        if (n++ === 0) throw new TypeError('Failed to fetch')
        throw Object.assign(new Error('not_found'), { status: 404 })
      },
    })
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    await r.call.stop()
    await vi.advanceTimersByTimeAsync(END_RETRY_MS)
    expect(r.caught).toEqual([null])
    await vi.advanceTimersByTimeAsync(END_RETRY_MS * 5)
    expect(r.box.ends).toHaveLength(2)
  })

  it('a call that ended cleanly is not asked about again', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    await r.call.stop()
    await vi.advanceTimersByTimeAsync(END_RETRY_MS * 5)
    expect(r.box.ends).toHaveLength(1)
    expect(r.caught).toEqual([])
  })

  it('leaving the page tells the box without waiting', async () => {
    const r = rig()
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    r.call.leave()
    expect(r.box.ends).toEqual([{ id: 'sess_1', opts: { keepalive: true } }])
    expect(r.track.stopped).toBe(true)
    expect(r.ended).toHaveLength(0)
  })

  it('a blocked microphone rejects before anything is created on the box', async () => {
    const r = rig({ deny: 'NotAllowedError' })
    await expect(r.call.start()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(r.box.started).toHaveLength(0)
    expect(r.call.phase).toBe('')
  })

  it('a refusal from the box releases the microphone', async () => {
    const r = rig({ startFails: Object.assign(new Error('not_configured'), { status: 503 }) })
    await expect(r.call.start()).rejects.toMatchObject({ status: 503 })
    expect(r.track.stopped).toBe(true)
    expect(FakePeer.last!.closed).toBe(true)
    expect(r.box.ends).toHaveLength(0)
  })

  it('End pressed while connecting ends the session as soon as it exists', async () => {
    const r = rig()
    const started = r.call.start()
    await r.call.stop()
    await started.catch(() => {})
    // Either it stopped before the box made the session, or it ended it straight after.
    expect(r.box.started.length === 0 || r.box.ends.length === 1).toBe(true)
    expect(r.call.phase).toBe('')
  })

  it('a session that never says it is live is ended', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.call.start()
    expect(r.call.phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + 10)
    expect(r.ended.map((e) => e.why)).toEqual(['lost'])
    expect(r.box.ends).toHaveLength(1)
  })
})

describe('api', () => {
  it('hangs up when the box says the call is over there (final review I2)', async () => {
    vi.useFakeTimers()
    let finished = false
    const r = rig({ status: async () => ({ finished, added: 0 }) })
    await r.call.start()
    const peer = FakePeer.last!
    peer.channel.event({ type: 'session.started' })
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS)
    expect(r.ended).toEqual([])
    finished = true
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS)
    expect(r.ended.map((e) => e.why)).toEqual(['closed'])
    expect(peer.closed).toBe(true)
    expect(r.track.stopped).toBe(true)
  })

  it('hangs up when the box no longer knows the call, or this page was signed out', async () => {
    vi.useFakeTimers()
    for (const status of [404, 401]) {
      const r = rig({ status: async () => { throw Object.assign(new Error('x'), { status }) } })
      await r.call.start()
      FakePeer.last!.channel.event({ type: 'session.started' })
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS)
      expect(r.ended.map((e) => e.why)).toEqual(['lost'])
    }
  })

  it('keeps going when the box is just unreachable for a moment', async () => {
    vi.useFakeTimers()
    const r = rig({ status: async () => { throw new TypeError('Failed to fetch') } })
    await r.call.start()
    FakePeer.last!.channel.event({ type: 'session.started' })
    await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
    expect(r.ended).toEqual([])
    await r.call.stop()
  })

  it('hangs up on its own after the longest call, even if it never hears from the box', async () => {
    vi.useFakeTimers()
    const r = rig({ status: async () => ({ finished: false }) })
    await r.call.start()
    const ch = FakePeer.last!.channel
    ch.event({ type: 'session.started' })
    // Talking the whole time, so only the length limit applies.
    for (let t = 0; t < MAX_CALL_MS - 60000; t += 60000) {
      ch.event({ type: 'session.input_transcript.delta', delta: 'still here' })
      await vi.advanceTimersByTimeAsync(60000)
    }
    expect(r.ended).toEqual([])
    ch.event({ type: 'session.input_transcript.delta', delta: 'still here' })
    await vi.advanceTimersByTimeAsync(60000)
    expect(r.ended.map((e) => e.why)).toEqual(['closed'])
  })

  it('hangs up after a long silence with nothing being looked up', async () => {
    vi.useFakeTimers()
    const r = rig()
    await r.call.start()
    const ch = FakePeer.last!.channel
    ch.event({ type: 'session.started' })
    ch.event({ type: 'session.delegation.created' })
    await vi.advanceTimersByTimeAsync(SILENCE_MS + STATUS_POLL_MS)
    expect(r.ended).toEqual([]) // a lookup is running
    ch.event({ type: 'session.commentary.appended' })
    await vi.advanceTimersByTimeAsync(SILENCE_MS - STATUS_POLL_MS)
    expect(r.ended).toEqual([])
    await vi.advanceTimersByTimeAsync(2 * STATUS_POLL_MS)
    expect(r.ended.map((e) => e.why)).toEqual(['closed'])
  })

  it('leaving the page while the box creates the session still ends it (final review m2)', async () => {
    let go!: () => void
    const r = rig({ startGate: new Promise<void>((res) => (go = res)) })
    const starting = r.call.start()
    await vi.waitFor(() => expect(r.box.started).toHaveLength(1))
    r.call.leave()
    go()
    await starting
    expect(r.box.ends).toEqual([{ id: 'sess_1', opts: { keepalive: true } }])
  })

  it('sends the chosen voice with the offer (card #257)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: 's', sdp: 'a' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await api.startVoiceCall('c1', 'v=0', 'willow')
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ sdp: 'v=0', voice: 'willow' })
  })

  it('starts with the offer and ends with wait or keepalive, as JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: 's', sdp: 'a' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await api.startVoiceCall('c 1', 'v=0')).toEqual({ sessionId: 's', sdp: 'a' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/web/conversations/c%201/voice')
    expect(JSON.parse(String(init.body))).toEqual({ sdp: 'v=0' })

    await api.endVoiceCall('s', { wait: true })
    const [u2, i2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(u2).toBe('/api/web/voice/end')
    expect((i2.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(i2.body))).toEqual({ sessionId: 's', wait: true })
    expect(await api.endVoiceCall('s', { keepalive: true })).toBeNull()
    expect((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].keepalive).toBe(true)

    await api.voiceCallStatus('s 1')
    expect((fetchMock.mock.calls[3] as unknown as [string])[0]).toBe('/api/web/voice/calls/s%201')
    expect(js).toContain('callStatus: (id) => api.voiceCallStatus(id)')
  })
})

describe('static checks', () => {
  it('the voice chat button is labelled, hidden until the box allows it, and apart from the microphone', () => {
    expect(html).toMatch(/<button type="button" id="call" class="icon-btn call-btn" aria-label="Start a voice chat"[^>]*aria-pressed="false" hidden>/)
    expect(html.indexOf('id="call"')).toBeLessThan(html.indexOf('id="mic"'))
    expect(html.indexOf('id="mic"')).toBeLessThan(html.indexOf('id="send"'))
    expect(html).toMatch(/id="call-end"[^>]*>End call</)
    expect(js).toContain("show($('call'), Boolean(state.me && state.me.voiceChat))")
  })

  it('leaving the chat or the page ends the call, and dictation is off during one', () => {
    expect(js).toContain("window.addEventListener('pagehide', leaveCall)")
    expect(js).toMatch(/function setCurrent[\s\S]{0,200}if \(vc\.call && \(!conv \|\| conv\.id !== vc\.convId\)\) endCall\(\)/)
    expect(js).toMatch(/async function beginDictation\(\) \{\s*if \(vc\.call\) return/)
    expect(js).toContain('mic.disabled = inCall && !dictate.phase')
  })
})
