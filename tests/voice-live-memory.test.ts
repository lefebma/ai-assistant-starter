/**
 * tests/voice-live-memory.test.ts
 *
 * Live calls are remembered: saveVoiceCall files each call (transcript,
 * exchanges, a summary) under the chat that owns the voice link, the next call
 * gets the tail of recent calls in its instructions, and the backend gets the
 * same memory context a chat message does. Filesystem work goes to a temp dir;
 * memory writes go through injected fakes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const { mockRunAgent, mockBuildContext } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockBuildContext: vi.fn(async (_chat: string, _msg: string) => ''),
}))
vi.mock('../src/agent.js', () => ({ runAgent: mockRunAgent }))
vi.mock('../src/skills/index.js', () => ({ buildSkillIndex: () => 'SKILL-INDEX' }))
vi.mock('../src/memory/engine.js', () => ({ createDefaultEngine: () => ({ buildContext: mockBuildContext }) }))

import {
  saveVoiceCall,
  recentCallsNote,
  transcriptDirFor,
  memoryChatId,
  buildLiveInstructions,
  createAssistantBackend,
  type VoiceCallDeps,
  type Turn,
} from '../src/voice-live.js'

const t = (who: Turn['who'], text: string): Turn => ({ who, text, start_ms: 0, end_ms: 0 })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'havn-voice-memory-'))
  mockRunAgent.mockReset()
  mockBuildContext.mockReset()
  mockBuildContext.mockResolvedValue('')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakes(overrides: Partial<VoiceCallDeps> = {}) {
  const writes: { path: string; content: string }[] = []
  const turns: { chatId: string; user: string; assistant: string }[] = []
  const inserts: { chatId: string; content: string; sector: string }[] = []
  const deps: VoiceCallDeps = {
    dir,
    timezone: 'America/Toronto',
    writeFile: (path, content) => writes.push({ path, content }),
    saveTurn: async (chatId, user, assistant) => { turns.push({ chatId, user, assistant }) },
    insert: (chatId, content, sector) => inserts.push({ chatId, content, sector }),
    ...overrides,
  }
  return { deps, writes, turns, inserts }
}

const call = (turnList: Turn[], extra: Partial<Parameters<typeof saveVoiceCall>[0]> = {}) => ({
  sessionId: 'live_abc123456',
  chatId: 'chat-42',
  startedAt: new Date('2026-09-13T15:40:00Z'),
  endedAt: new Date('2026-09-13T15:43:10Z'),
  turns: turnList,
  delegations: 1,
  billedSeconds: 190,
  ...extra,
})

describe('saveVoiceCall', () => {
  it('saves nothing when the user never spoke', async () => {
    const f = fakes()
    expect(await saveVoiceCall(call([t('assistant', 'Hey there'), t('user', '   ')]), f.deps)).toBeNull()
    expect(f.writes).toHaveLength(0)
    expect(f.turns).toHaveLength(0)
    expect(f.inserts).toHaveLength(0)
  })

  it('writes the transcript at a local-time path with the call details', async () => {
    const f = fakes()
    const path = await saveVoiceCall(call([t('user', 'What is on my calendar tomorrow morning'), t('assistant', 'Two meetings before noon.')]), f.deps)
    expect(path).toBe(join(dir, '2026-09-13-11-40-456789'.replace('456789', '123456') + '.md'))
    const body = f.writes[0]!.content
    expect(body).toMatch(/^# Voice call, /)
    expect(body).toContain('Duration: ~3 min (190s billed)')
    expect(body).toContain('1 backend lookup')
    expect(body).toContain('**User:** What is on my calendar tomorrow morning')
    expect(body).toContain('**Assistant:** Two meetings before noon.')
  })

  it('pairs user runs with the replies that follow, skipping short asks and leading assistant turns', async () => {
    const f = fakes()
    await saveVoiceCall(call([
      t('assistant', 'Hi, what can I do?'),
      t('user', 'Hey'),
      t('assistant', 'Hey!'),
      t('user', 'Can you check the weather'),
      t('user', 'for Toronto tomorrow please'),
      t('assistant', 'Checking.'),
      t('assistant', 'Sunny, high of twenty.'),
    ]), f.deps)
    expect(f.turns).toEqual([
      { chatId: 'chat-42', user: '(by voice) Can you check the weather for Toronto tomorrow please', assistant: 'Checking. Sunny, high of twenty.' },
    ])
  })

  it('files one episodic summary under the chat, pointing at the transcript', async () => {
    const f = fakes()
    await saveVoiceCall(call([t('user', 'Remind me what we decided about pricing')], { delegations: 3 }), f.deps)
    expect(f.inserts).toHaveLength(1)
    expect(f.inserts[0]!.chatId).toBe('chat-42')
    expect(f.inserts[0]!.sector).toBe('episodic')
    expect(f.inserts[0]!.content).toContain('3 backend lookups')
    expect(f.inserts[0]!.content).toContain('The user said: Remind me what we decided about pricing')
    expect(f.inserts[0]!.content).toContain('[transcript: ')
  })

  it('writes the real file privately when no writer is injected', async () => {
    const { writeFile: _w, ...deps } = fakes().deps
    const path = await saveVoiceCall(call([t('user', 'A question long enough to be saved')]), deps)
    expect(readFileSync(path!, 'utf-8')).toContain('A question long enough to be saved')
  })
})

describe('where voice memory is filed', () => {
  it('keeps chat ids path-safe', () => {
    expect(transcriptDirFor('19:abc/../x@thread.v2', dir)).toBe(join(dir, '19_abc____x_thread_v2'))
    expect(transcriptDirFor('229610809', dir)).toBe(join(dir, '229610809'))
  })

  it('never resolves outside the transcript root, whatever the chat id', () => {
    for (const hostile of ['..', '.', '../..', '/etc', '..\\..', '%2e%2e', '']) {
      const out = transcriptDirFor(hostile, dir)
      expect(out.startsWith(dir + sep)).toBe(true)
      expect(out).not.toBe(dir)
    }
  })

  it('uses the link chat, falling back when the operator bearer has none', () => {
    expect(memoryChatId('chat-7')).toBe('chat-7')
    expect(memoryChatId(null)).not.toBe('')
  })
})

describe('recentCallsNote', () => {
  function transcript(name: string, lines: string[], ageDays: number) {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, [`# Voice call, ${name}`, '', '- Duration: ~1 min', '', ...lines].join('\n'))
    const when = (Date.now() - ageDays * 86_400_000) / 1000
    utimesSync(path, when, when)
  }

  it('is empty when there are no calls', () => {
    expect(recentCallsNote('chat-42', { dir: join(dir, 'missing') })).toBe('')
  })

  it('returns the newest calls first, only the turn lines, and skips stale ones', () => {
    transcript('old.md', ['**User:** ancient history'], 30)
    transcript('a.md', ['**User:** first call question', '**Assistant:** first answer'], 2)
    transcript('b.md', ['**User:** second call question', '**Assistant:** second answer'], 1)
    const note = recentCallsNote('chat-42', { dir })
    expect(note.indexOf('second call question')).toBeLessThan(note.indexOf('first call question'))
    expect(note).toContain('Assistant: first answer')
    expect(note).not.toContain('**')
    expect(note).not.toContain('ancient history')
    expect(note).not.toContain('Duration')
  })

  it('keeps the end of a long call', () => {
    transcript('long.md', Array.from({ length: 80 }, (_, i) => `**User:** line number ${i}`), 0)
    const note = recentCallsNote('chat-42', { dir, perCallChars: 200 })
    expect(note).toContain('line number 79')
    expect(note).not.toContain('line number 0\n')
    expect(note).toContain('...')
  })
})

describe('recall', () => {
  it('puts recent calls in the voice model instructions', () => {
    const text = buildLiveInstructions({ assistant: 'Nami', owner: 'Marc' }, '', 'Voice call, Sun:\nUser: pricing question')
    expect(text).toContain('Recent voice calls with Marc')
    expect(text).toContain('User: pricing question')
    expect(buildLiveInstructions({ assistant: 'Nami', owner: 'Marc' }, '', '')).not.toContain('Recent voice calls')
  })

  it('gives the backend the skill index and memory context for the call chat', async () => {
    mockBuildContext.mockResolvedValue('<memory-context>earlier call about pricing</memory-context>')
    mockRunAgent.mockResolvedValue({ text: 'ok', newSessionId: 's1' })
    const backend = createAssistantBackend('chat-42')
    await backend('what did we say about pricing?', new AbortController().signal)
    expect(mockBuildContext).toHaveBeenCalledWith('chat-42', 'what did we say about pricing?')
    const prompt = mockRunAgent.mock.calls[0]![0] as string
    expect(prompt).toContain('SKILL-INDEX')
    expect(prompt).toContain('earlier call about pricing')
    expect(prompt.endsWith('what did we say about pricing?')).toBe(true)
  })
})
