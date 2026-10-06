/**
 * tests/voice-live-duplex.test.ts
 *
 * Feature #188 on top of the 1.26.0 live page: spoken answers stay short and
 * the rest goes to the chat (#191), work that outlives the call is delivered
 * to the chat (#191), a call nobody is on can be detected (#190), and past
 * calls can be listed, opened, deleted and pruned (#193).
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('../src/skills/index.js', () => ({ buildSkillIndex: () => '' }))
vi.mock('../src/memory/engine.js', () => ({ createDefaultEngine: () => ({ buildContext: async () => '' }) }))

import { createLiveBridge, splitResult, SPOKEN_RESULT_WORDS, saveVoiceCall } from '../src/voice-live.js'
import { parseTranscript, listVoiceCalls, getVoiceCall, deleteVoiceCall, pruneVoiceTranscripts, transcriptDirFor, stampToMs } from '../src/voice-history.js'

type Sent = { type: string; content?: string; [k: string]: unknown }

function harness(opts: { result: string; deliver?: (t: string) => Promise<boolean> }) {
  const sent: Sent[] = []
  const prompts: string[] = []
  const bridge = createLiveBridge({
    send: (e) => sent.push(e as Sent),
    runBackend: async (prompt) => {
      prompts.push(prompt)
      return opts.result
    },
    settleMs: 0,
    deliver: opts.deliver,
  })
  const spoken = () => sent.filter((e) => e.type === 'session.commentary.append').map((e) => e.content).join('')
  return { bridge, sent, prompts, spoken }
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('splitResult (#191: spoken answers stay under a set length)', () => {
  it('passes a short answer through untouched', () => {
    expect(splitResult('You have two meetings today.')).toEqual({ spoken: 'You have two meetings today.', forChat: null })
  })

  it('sends what follows FOR CHAT: to the chat and speaks only the summary', () => {
    const r = splitResult('Three invoices are overdue.\nFOR CHAT:\nINV-1 $200\nINV-2 $300\nINV-3 $50')
    expect(r.spoken).toBe('Three invoices are overdue.')
    expect(r.forChat).toBe('INV-1 $200\nINV-2 $300\nINV-3 $50')
  })

  it('cuts an over-long spoken part at the last sentence that fits, and sends the whole answer to chat', () => {
    const first = `${words(60)}.`
    const second = `${words(50)}.`
    const third = `${words(40)}.`
    const r = splitResult(`${first} ${second} ${third}`)
    expect(r.spoken).toBe(`${first} ${second}`)
    expect(r.spoken.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_RESULT_WORDS)
    expect(r.forChat).toContain(third)
  })

  it('cuts a single run-on sentence at the word budget', () => {
    const r = splitResult(words(300), 100)
    expect(r.spoken.split(/\s+/).length).toBe(100)
    expect(r.spoken.endsWith('...')).toBe(true)
    expect(r.forChat).toBe(words(300))
  })

  it('still says something when the backend put everything in the chat part', () => {
    expect(splitResult('FOR CHAT:\nthe draft').spoken).toBe('The answer is in your chat.')
  })
})

describe('the bridge with a chat to deliver to', () => {
  it('speaks the summary, delivers the details, and tells the voice model it did', async () => {
    const deliver = vi.fn(async () => true)
    const h = harness({ result: 'Here is the draft.\nFOR CHAT:\nDear Dana, ...', deliver })
    await h.bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' } })
    expect(deliver).toHaveBeenCalledWith('Dear Dana, ...')
    expect(h.spoken()).toContain('Here is the draft.')
    expect(h.spoken()).toContain('sent to the user')
    expect(h.spoken()).not.toContain('Dear Dana')
  })

  it('speaks everything when the chat cannot be reached, rather than losing it', async () => {
    const h = harness({ result: 'Summary.\nFOR CHAT:\nDetails here', deliver: async () => false })
    await h.bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' } })
    expect(h.spoken()).toContain('Details here')
    expect(h.spoken()).not.toContain('FOR CHAT')
  })

  it('delivers a result that lands after the call ended to the chat, and sends nothing to the dead session', async () => {
    const deliver = vi.fn(async () => true)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const sent: Sent[] = []
    const bridge = createLiveBridge({
      send: (e) => sent.push(e as Sent),
      runBackend: async () => {
        await gate
        return 'Booked for Tuesday at 10.'
      },
      settleMs: 0,
      deliver,
    })
    const run = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' } })
    bridge.end()
    release()
    await run
    expect(deliver).toHaveBeenCalledWith('From your call:\n\nBooked for Tuesday at 10.')
    expect(sent.some((e) => e.type === 'session.commentary.append')).toBe(false)
  })

  it('tells the backend to read back exact content before sending anything', async () => {
    const h = harness({ result: 'ok' })
    await h.bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' } })
    expect(h.prompts[0]).toContain('FOR CHAT:')
    expect(h.prompts[0]).toContain('explicitly confirmed the exact content')
    expect(h.prompts[0]).toContain('return the exact text to be sent')
  })
})

describe('idle detection (#190: a call nobody is on ends)', () => {
  it('is idle only after the quiet period and never while a lookup runs', async () => {
    let release!: (v: string) => void
    const bridge = createLiveBridge({ send: () => {}, runBackend: () => new Promise<string>((r) => (release = r)), settleMs: 0 })
    const now = Date.now()
    expect(bridge.idleFor(60_000, now)).toBe(false)
    expect(bridge.idleFor(60_000, now + 61_000)).toBe(true)
    const run = bridge.onEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'd1' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(bridge.idleFor(60_000, now + 10 * 60_000)).toBe(false)
    release('done')
    await run
    bridge.onEvent({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 100 })
    expect(bridge.idleFor(60_000, Date.now() + 1000)).toBe(false)
  })
})

describe('call history (#193)', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'havn-calls-'))

  async function saved(dir: string, chat: string, startedAt: Date, said: string, seconds?: number) {
    return saveVoiceCall(
      {
        sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
        chatId: chat,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 125_000),
        turns: [
          { who: 'user', text: 'Hi there', start_ms: 0, end_ms: 100 },
          { who: 'assistant', text: 'Hey.', start_ms: 200, end_ms: 300 },
          { who: 'user', text: said, start_ms: 2000, end_ms: 2600 },
          { who: 'assistant', text: 'You have two meetings.', start_ms: 3000, end_ms: 3500 },
        ],
        delegations: 1,
        billedSeconds: seconds,
      },
      { dir: transcriptDirFor(chat, dir), timezone: 'America/Toronto', saveTurn: async () => {}, insert: () => {} },
    )
  }

  it('saves the exact start and length, and lists calls newest first with a title from what the user asked', async () => {
    const dir = root()
    await saved(dir, 'chat-a', new Date('2026-10-01T14:00:00Z'), 'What is on my calendar tomorrow?', 125)
    await saved(dir, 'chat-a', new Date('2026-10-03T14:00:00Z'), 'Draft a note to Dana about the renewal')
    const calls = listVoiceCalls('chat-a', { root: dir, timeZone: 'America/Toronto' })
    expect(calls.map((c) => c.title)).toEqual(['Draft a note to Dana about the renewal', 'What is on my calendar tomorrow?'])
    expect(calls[1].startedAt).toBe(Date.parse('2026-10-01T14:00:00Z'))
    expect(calls[1].seconds).toBe(125)
    expect(calls[0].seconds).toBe(125) // computed from start and end when nothing was billed
    expect(calls[0].lookups).toBe(1)
  })

  it('opens a transcript with every turn', async () => {
    const dir = root()
    const path = (await saved(dir, 'chat-a', new Date('2026-10-02T14:00:00Z'), 'What is on my calendar tomorrow?'))!
    const id = path.split('/').pop()!.replace(/\.md$/, '')
    const call = getVoiceCall('chat-a', id, { root: dir })!
    expect(call.turns).toHaveLength(4)
    expect(call.turns[2]).toEqual({ who: 'user', text: 'What is on my calendar tomorrow?' })
  })

  it('keeps chats apart: one chat never sees, opens or deletes another chat\'s call', async () => {
    const dir = root()
    const path = (await saved(dir, 'chat-a', new Date('2026-10-02T14:00:00Z'), 'Private question for chat A'))!
    const id = path.split('/').pop()!.replace(/\.md$/, '')
    expect(listVoiceCalls('chat-b', { root: dir })).toEqual([])
    expect(getVoiceCall('chat-b', id, { root: dir })).toBeNull()
    expect(deleteVoiceCall('chat-b', id, { root: dir })).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('refuses ids that try to leave the chat directory', () => {
    const dir = root()
    mkdirSync(join(dir, 'chat-b'), { recursive: true })
    writeFileSync(join(dir, 'chat-b', 'secret.md'), '**User:** hi')
    for (const id of ['../chat-b/secret', '..%2Fchat-b%2Fsecret', '', 'a/b', '.']) {
      expect(getVoiceCall('chat-a', id, { root: dir })).toBeNull()
      expect(deleteVoiceCall('chat-a', id, { root: dir })).toBe(false)
    }
    expect(existsSync(join(dir, 'chat-b', 'secret.md'))).toBe(true)
  })

  it('deletes a call', async () => {
    const dir = root()
    const path = (await saved(dir, 'chat-a', new Date('2026-10-02T14:00:00Z'), 'What is on my calendar tomorrow?'))!
    const id = path.split('/').pop()!.replace(/\.md$/, '')
    expect(deleteVoiceCall('chat-a', id, { root: dir })).toBe(true)
    expect(listVoiceCalls('chat-a', { root: dir })).toEqual([])
  })

  it('reads transcripts saved before 1.32 (no Started or Seconds line) from the filename and duration', () => {
    const raw = ['# Voice call, Mon, Oct 5, 9:30 p.m.', '', '- Duration: ~3 min', '- 2 backend lookups', '- Session: sess_x', '', '**User:** What is the weather in Toronto?', '', '**Assistant:** Cloudy, 12 degrees.', ''].join('\n')
    const call = parseTranscript('2026-10-05-21-30-abc123', raw, 0, 'America/Toronto')
    expect(call.startedAt).toBe(Date.parse('2026-10-06T01:30:00Z'))
    expect(call.seconds).toBe(180)
    expect(call.lookups).toBe(2)
    expect(call.title).toBe('What is the weather in Toronto?')
  })

  it('converts filename stamps across a daylight-saving change', () => {
    expect(stampToMs('2026-01-15-09-00-x', 'America/Toronto', 0)).toBe(Date.parse('2026-01-15T14:00:00Z'))
    expect(stampToMs('2026-07-15-09-00-x', 'America/Toronto', 0)).toBe(Date.parse('2026-07-15T13:00:00Z'))
  })

  it('prunes transcripts older than the retention setting, across chats, and keeps everything at 0', async () => {
    const dir = root()
    const oldPath = (await saved(dir, 'chat-a', new Date('2026-08-01T14:00:00Z'), 'An old question from August'))!
    const newPath = (await saved(dir, 'chat-b', new Date('2026-10-04T14:00:00Z'), 'A recent question from October'))!
    const now = Date.parse('2026-10-05T14:00:00Z')
    utimesSync(oldPath, new Date('2026-08-01T14:05:00Z'), new Date('2026-08-01T14:05:00Z'))
    utimesSync(newPath, new Date('2026-10-04T14:05:00Z'), new Date('2026-10-04T14:05:00Z'))
    expect(pruneVoiceTranscripts(0, { root: dir, now })).toBe(0)
    expect(pruneVoiceTranscripts(30, { root: dir, now })).toBe(1)
    expect(existsSync(oldPath)).toBe(false)
    expect(readFileSync(newPath, 'utf-8')).toContain('A recent question')
  })
})
