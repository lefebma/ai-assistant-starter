/**
 * tests/voice-live.test.ts
 *
 * createLiveBridge is the transport-independent half of src/voice-live.ts: it
 * owns the transcript merge, the delegation lifecycle, cancellation of
 * superseded requests, and takes fake send/runBackend so none of this needs a
 * real WebSocket or an OpenAI key. Ported with the feature from the assistant
 * this product came from.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// createAssistantBackend needs runAgent mocked so it never spawns Claude.
const { mockRunAgent } = vi.hoisted(() => ({ mockRunAgent: vi.fn() }))
vi.mock('../src/agent.js', () => ({ runAgent: mockRunAgent }))
vi.mock('../src/skills/index.js', () => ({ buildSkillIndex: () => '' }))
vi.mock('../src/memory/engine.js', () => ({ createDefaultEngine: () => ({ buildContext: async () => '' }) }))

import { createLiveBridge, createAssistantBackend, buildLiveInstructions } from '../src/voice-live.js'

type SendCall = { type: string; delegation_id?: string | null; content?: string; [k: string]: any }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeSend() {
  const calls: SendCall[] = []
  const send = (event: SendCall) => {
    calls.push(event)
  }
  return { send, calls }
}

describe('createLiveBridge transcript merging', () => {
  it('should merge same-speaker deltas within 1500ms and split on gap or speaker change', () => {
    const { send, calls } = makeSend()
    const bridge = createLiveBridge({ send, runBackend: async () => '', settleMs: 0 })

    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'Hey', start_ms: 0, end_ms: 200 })
    // same speaker, gap 800ms < 1500ms -> merges into the same turn
    bridge.onEvent({ type: 'session.input_transcript.delta', delta: ' there', start_ms: 1000, end_ms: 1200 })
    // speaker change -> new turn even though the gap is small
    bridge.onEvent({ type: 'session.output_transcript.delta', delta: 'Hi Marc', start_ms: 1300, end_ms: 1500 })
    // speaker change back -> new turn
    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'How are you', start_ms: 5000, end_ms: 5200 })
    // same speaker, gap 1600ms >= 1500ms -> new turn, not merged
    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'today', start_ms: 6800, end_ms: 7000 })

    expect(bridge.transcript()).toBe('User: Hey there\nAssistant: Hi Marc\nUser: How are you\nUser: today')
    expect(calls).toHaveLength(0) // pure transcript events never call send
  })
})

describe('createLiveBridge delegation handling', () => {
  it('should progress, call the backend with the transcript, and commentary the result for a client delegation', async () => {
    const { send, calls } = makeSend()
    const runBackend = async (prompt: string) => {
      expect(prompt).toContain('User: Hello Umi')
      return 'The answer is 4.'
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0 })

    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'Hello Umi', start_ms: 0, end_ms: 200 })
    await bridge.onEvent({
      type: 'session.delegation.created',
      delegation: { target: 'client', id: 'del-1' },
    })

    const thinking = calls.find((c) => c.type === 'session.thinking.append')
    expect(thinking?.delegation_id).toBe('del-1')

    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].delegation_id).toBe('del-1')
    expect(commentary[0].content).toBe('The answer is 4.')

    // thinking must be sent before commentary
    expect(calls.indexOf(thinking!)).toBeLessThan(calls.indexOf(commentary[0]))

    expect(bridge.metrics()).toEqual([{ delegationId: 'del-1', ms: expect.any(Number), superseded: false, cancelled: false }])
  })

  it('should split results longer than 1500 chars into multiple commentary appends', async () => {
    const { send, calls } = makeSend()
    const longResult = 'A'.repeat(1500) + 'B'.repeat(300)
    const bridge = createLiveBridge({ send, runBackend: async () => longResult, settleMs: 0 })

    await bridge.onEvent({
      type: 'session.delegation.created',
      delegation: { target: 'client', id: 'del-long' },
    })

    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(2)
    expect(commentary[0].content).toHaveLength(1500)
    expect(commentary[1].content).toHaveLength(300)
    expect(commentary.every((c) => c.delegation_id === 'del-long')).toBe(true)
    expect(commentary.map((c) => c.content).join('')).toBe(longResult)
  })

  it('should abort the superseded delegation, wait for it to settle, then call the backend for the later one', async () => {
    const { send, calls } = makeSend()
    const d1 = deferred<string>()
    const backendCalls: string[] = []
    const runBackend = async (prompt: string, signal: AbortSignal) => {
      backendCalls.push(prompt)
      if (backendCalls.length === 1) {
        // Simulates the killed Claude subprocess: it only settles once its
        // own signal aborts, then waits on d1 (test controls exactly when).
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            d1.promise.then(() => reject(new Error('cancelled')))
          }, { once: true })
        })
      }
      return 'second result'
    }
    // cancelWaitMs is generous here so the "waits for settle" path is what
    // resolves this test, not the timeout fallback (covered separately below).
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0, cancelWaitMs: 5000 })

    const p1 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'first' } })
    const p2 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'second' } })

    // The second delegation must not call the backend until the first (now
    // aborted) run actually settles -- give pending microtasks a couple of
    // ticks and confirm it is still only one call deep.
    await Promise.resolve()
    await Promise.resolve()
    expect(backendCalls).toHaveLength(1)

    d1.resolve('unused')
    await Promise.all([p1, p2])

    expect(backendCalls).toHaveLength(2)
    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].delegation_id).toBe('second')
    expect(commentary[0].content).toBe('second result')

    const metrics = bridge.metrics()
    expect(metrics.find((m) => m.delegationId === 'first')).toMatchObject({ superseded: true, cancelled: true })
    expect(metrics.find((m) => m.delegationId === 'second')).toMatchObject({ superseded: false, cancelled: false })
  })

  it('should proceed to call the backend after cancelWaitMs even if the cancelled delegation never settles', async () => {
    const { send, calls } = makeSend()
    const backendCalls: string[] = []
    const runBackend = async (prompt: string) => {
      backendCalls.push(prompt)
      if (backendCalls.length === 1) return new Promise<string>(() => {}) // never settles
      return 'second result'
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0, cancelWaitMs: 20 })

    const p1 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'first' } })
    const p2 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'second' } })
    void p1 // the first delegation's backend call never resolves; nothing to await

    await p2

    expect(backendCalls).toHaveLength(2)
    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].delegation_id).toBe('second')
    expect(commentary[0].content).toBe('second result')
  }, 2000)

  it('should include the CANCELLED_NOTE and the full call transcript (from turn 0) in the second delegation prompt', async () => {
    const { send } = makeSend()
    const prompts: string[] = []
    const d1 = deferred<string>()
    const runBackend = async (prompt: string) => {
      prompts.push(prompt)
      return prompts.length === 1 ? d1.promise : 'second result'
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0, cancelWaitMs: 20 })

    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'Book me a flight to Montreal', start_ms: 0, end_ms: 500 })
    const p1 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'first' } })

    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'Actually make it Toronto', start_ms: 5000, end_ms: 5500 })
    const p2 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'second' } })

    await p2
    d1.resolve('unused')
    await p1

    expect(prompts).toHaveLength(2)
    const [firstPrompt, secondPrompt] = prompts
    expect(firstPrompt).not.toContain('An earlier backend request')

    expect(secondPrompt).toContain('An earlier backend request in this call was cancelled')
    expect(secondPrompt).toContain('check current state before repeating any action')
    // After a cancellation the backend gets the whole call from turn 0, not
    // just the delta since the last delivered turn -- because createAssistantBackend
    // starts a fresh Claude session after an abort (resuming the cancelled
    // run's session is unsafe), so there is no continuity to build on.
    expect(secondPrompt).toContain('Book me a flight to Montreal')
    expect(secondPrompt).toContain('Actually make it Toronto')
  })

  it('should bound the transcript window to the last few turns (not the whole call) when nothing was cancelled', async () => {
    const { send } = makeSend()
    const prompts: string[] = []
    const runBackend = async (prompt: string) => {
      prompts.push(prompt)
      return `result ${prompts.length}`
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0 })

    // Six turns, then a normal (non-cancelled) delegation resolves fully.
    for (let i = 0; i < 6; i++) {
      bridge.onEvent({ type: 'session.input_transcript.delta', delta: `turn ${i}`, start_ms: i * 5000, end_ms: i * 5000 + 500 })
    }
    await bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'del-1' } })

    // One more turn, then a second delegation with nothing cancelled.
    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'turn 6', start_ms: 40000, end_ms: 40500 })
    await bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'del-2' } })

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('An earlier backend request')
    // deliveredThrough advanced to 6 after del-1, so del-2's window starts at
    // Math.max(0, 6 - 4) = 2: turns 2 through 6 are in, 0 and 1 are dropped.
    expect(prompts[1]).toContain('turn 2')
    expect(prompts[1]).toContain('turn 6')
    expect(prompts[1]).not.toContain('turn 0')
    expect(prompts[1]).not.toContain('turn 1')
  })

  it('should send no commentary when a backend rejects after its delegation was aborted', async () => {
    const { send, calls } = makeSend()
    const backendCalls: string[] = []
    const runBackend = async (prompt: string, signal: AbortSignal) => {
      backendCalls.push(prompt)
      if (backendCalls.length === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('subprocess killed')), { once: true })
        })
      }
      return 'second result'
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0, cancelWaitMs: 20 })

    const p1 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'first' } })
    const p2 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'second' } })

    await Promise.all([p1, p2])

    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].delegation_id).toBe('second')
  })

  it('should, for a rapid triple delegation, only call the backend for delegations not aborted while waiting, and only the last one speaks', async () => {
    const { send, calls } = makeSend()
    const backendCalls: string[] = []
    const runBackend = async (prompt: string, signal: AbortSignal) => {
      backendCalls.push(prompt)
      return new Promise<string>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('already aborted'))
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        // Only the surviving (last) delegation's backend call actually resolves.
        if (backendCalls.length > 1) resolve(`result #${backendCalls.length}`)
      })
    }
    const bridge = createLiveBridge({ send, runBackend, settleMs: 0, cancelWaitMs: 20 })

    const p1 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'first' } })
    const p2 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'second' } })
    const p3 = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'third' } })

    await Promise.all([p1, p2, p3])

    // 'second' was itself aborted (by 'third') while still waiting on 'first'
    // to settle, so it never reached its own runBackend call.
    expect(backendCalls).toHaveLength(2)
    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].delegation_id).toBe('third')
  }, 2000)

  it('should send the error sentence, not crash, when the backend throws', async () => {
    const { send, calls } = makeSend()
    const bridge = createLiveBridge({
      send,
      runBackend: async () => {
        throw new Error('boom')
      },
      settleMs: 0,
    })

    await expect(
      bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'del-err' } }),
    ).resolves.toBeUndefined()

    const commentary = calls.filter((c) => c.type === 'session.commentary.append')
    expect(commentary).toHaveLength(1)
    expect(commentary[0].content).toBe('The backend hit an error and could not finish that request.')
  })

  it('should ignore delegations not targeted at the client', async () => {
    const { send, calls } = makeSend()
    let backendCalled = false
    const bridge = createLiveBridge({
      send,
      runBackend: async () => {
        backendCalled = true
        return 'should not run'
      },
      settleMs: 0,
    })

    await bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'server', id: 'ignored' } })

    expect(calls).toHaveLength(0)
    expect(backendCalled).toBe(false)
  })
})


describe('createLiveBridge turns()', () => {
  it('should return trimmed text and drop empty turns', () => {
    const { send } = makeSend()
    const bridge = createLiveBridge({ send, runBackend: async () => '', settleMs: 0 })

    bridge.onEvent({ type: 'session.input_transcript.delta', delta: ' Hey ', start_ms: 0, end_ms: 200 })
    // speaker change -> new turn; delta is all whitespace so it trims to empty and is dropped
    bridge.onEvent({ type: 'session.output_transcript.delta', delta: '   ', start_ms: 5000, end_ms: 5100 })

    expect(bridge.turns()).toEqual([{ who: 'user', text: 'Hey', start_ms: 0, end_ms: 200 }])
  })
})


describe('createAssistantBackend', () => {
  beforeEach(() => {
    mockRunAgent.mockReset()
  })

  it('should resume the session newSessionId returns on the next call', async () => {
    mockRunAgent
      .mockResolvedValueOnce({ text: 'first reply', newSessionId: 'sess-1' })
      .mockResolvedValueOnce({ text: 'second reply', newSessionId: 'sess-1' })
    const backend = createAssistantBackend()
    const controller = new AbortController()

    const first = await backend('first prompt', controller.signal)
    expect(first).toBe('first reply')
    expect(mockRunAgent.mock.calls[0]?.[1]).toBeUndefined() // no prior session to resume

    const second = await backend('second prompt', controller.signal)
    expect(second).toBe('second reply')
    expect(mockRunAgent.mock.calls[1]?.[1]).toBe('sess-1') // resumes the session from the first call
  })

  it('should return empty string and forget the session when the caller signal is aborted, so the next call starts fresh instead of resuming it', async () => {
    mockRunAgent
      .mockResolvedValueOnce({ text: 'partial reply', newSessionId: 'sess-aborted' })
      .mockResolvedValueOnce({ text: 'fresh reply', newSessionId: 'sess-fresh' })
    const backend = createAssistantBackend()

    const abortedController = new AbortController()
    abortedController.abort()
    const result = await backend('cancelled prompt', abortedController.signal)

    expect(result).toBe('')

    const freshController = new AbortController()
    const next = await backend('next prompt', freshController.signal)

    expect(next).toBe('fresh reply')
    // The call after an aborted run must NOT resume the session the aborted
    // run created -- resuming it live threw error_during_execution followed
    // by an unhandled EPIPE (2026-09-13).
    expect(mockRunAgent.mock.calls[1]?.[1]).toBeUndefined()
  })

  it('should not forget the session when the signal is not aborted', async () => {
    mockRunAgent.mockResolvedValueOnce({ text: 'ok', newSessionId: 'sess-keep' })
    const backend = createAssistantBackend()
    const controller = new AbortController()

    await backend('prompt', controller.signal)
    mockRunAgent.mockResolvedValueOnce({ text: 'ok again', newSessionId: 'sess-keep' })
    await backend('next prompt', controller.signal)

    expect(mockRunAgent.mock.calls[1]?.[1]).toBe('sess-keep')
  })
})


describe('buildLiveInstructions', () => {
  it('names the assistant and owner and carries the personality excerpt', () => {
    const text = buildLiveInstructions({ assistant: 'Joy', owner: 'Marina' }, 'Your name is Joy. Warm and upbeat.')
    expect(text).toContain("You are Joy, Marina's personal AI assistant")
    expect(text).toContain('Warm and upbeat.')
    expect(text).toContain('Delegate to the backend when:')
  })

  it('still reads cleanly with no owner or personality', () => {
    const text = buildLiveInstructions({ assistant: 'Assistant', owner: '' }, '')
    expect(text).toContain("the user's personal AI assistant")
    expect(text).not.toContain('Personality (')
  })
})
