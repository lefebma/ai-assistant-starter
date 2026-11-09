/** Import from ChatGPT (Feature #282): the parser, transcripts and history files. */
import { describe, it, expect } from 'vitest'
import { CHAT_LIMITS, INDEX_FILE, historyFiles, parseChatGPTConversations, splitText, transcript, type ChatConversation } from '../src/projects/chatgpt-export.js'
import { conversation, day } from './chatgpt-fixture.js'

const ok = (data: unknown) => {
  const r = parseChatGPTConversations(data)
  if (!r.ok) throw new Error(r.code)
  return r
}

describe('parseChatGPTConversations', () => {
  it('groups project conversations by project, newest first, and ignores the rest', () => {
    const r = ok([
      conversation({ id: 'c1', project: 'g-p-old', updated: day('2025-01-02'), messages: [{ role: 'user', text: 'hi' }] }),
      conversation({ id: 'c2', project: 'g-p-new', updated: day('2025-06-01'), messages: [{ role: 'user', text: 'hello' }] }),
      conversation({ id: 'c3', project: 'g-p-old', updated: day('2025-03-01'), messages: [{ role: 'user', text: 'later' }] }),
      conversation({ id: 'c4', project: null, messages: [{ role: 'user', text: 'not in a project' }] }),
      conversation({ id: 'c5', project: 'g-WKIaLGGem', messages: [{ role: 'user', text: 'a custom GPT, not a project' }] }),
    ])
    expect(r.projects.map((p) => [p.id, p.conversations.map((c) => c.id)])).toEqual([
      ['g-p-new', ['c2']],
      ['g-p-old', ['c3', 'c1']],
    ])
    expect(r.unreadable).toBe(0)
  })

  it('follows the thread from current_node, leaving out edited-away branches', () => {
    const r = ok([
      conversation({
        id: 'c1',
        branch: [{ role: 'user', text: 'the version I edited away' }],
        messages: [
          { role: 'user', text: 'first' },
          { role: 'assistant', text: 'second' },
        ],
      }),
    ])
    expect(r.projects[0]!.conversations[0]!.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first'],
      ['assistant', 'second'],
    ])
  })

  it('keeps what a person reads and drops system, tool, hidden, thinking and empty messages', () => {
    const r = ok([
      conversation({
        id: 'c1',
        messages: [
          { role: 'system', text: 'You are ChatGPT.' },
          { role: 'user', text: 'context', hidden: true },
          { role: 'user', parts: ['look at this', { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' }], contentType: 'multimodal_text' },
          { role: 'assistant', text: 'search("x")', recipient: 'web' },
          { role: 'tool', text: 'results' },
          { role: 'assistant', text: 'pondering', contentType: 'thoughts' },
          { role: 'user', parts: [{ content_type: 'audio_transcription', text: 'spoken words' }, { content_type: 'audio_asset_pointer' }], contentType: 'multimodal_text' },
          { role: 'assistant', text: '   ' },
          { role: 'assistant', text: 'the answer' },
        ],
      }),
    ])
    expect(r.projects[0]!.conversations[0]!.messages.map((m) => m.text)).toEqual(['look at this\n\n[picture]', 'spoken words', 'the answer'])
  })

  it('survives a cycle, a missing parent and bad field types', () => {
    const c = conversation({ id: 'c1', messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] })
    const mapping = c.mapping as Record<string, { parent: string | null }>
    mapping['c1-m0']!.parent = 'c1-m1' // a loop
    const odd = { ...conversation({ id: 'c2', messages: [{ role: 'user', text: 'x' }] }), title: 42, create_time: 'soon', current_node: 'nowhere' }
    const r = ok([c, odd])
    const byId = Object.fromEntries(r.projects[0]!.conversations.map((x) => [x.id, x]))
    expect(byId['c1']!.messages.map((m) => m.text)).toEqual(['a', 'b'])
    expect(byId['c2']).toMatchObject({ title: '', messages: [] })
  })

  it('counts an unreadable project conversation and keeps a repeated one once', () => {
    const c = conversation({ id: 'c1', messages: [{ role: 'user', text: 'a' }] })
    const r = ok([c, c, { conversation_template_id: 'g-p-aaaa1111', mapping: 'not an object' }])
    expect(r.projects[0]!.conversations).toHaveLength(1)
    expect(r.unreadable).toBe(1)
  })

  it('refuses what is not a ChatGPT export, and says when no project is in it', () => {
    expect(parseChatGPTConversations({ projects: [] })).toEqual({ ok: false, code: 'not_chatgpt' })
    expect(parseChatGPTConversations([{ uuid: 'x', name: 'a Claude project' }])).toEqual({ ok: false, code: 'not_chatgpt' })
    expect(parseChatGPTConversations([conversation({ id: 'c', project: null, messages: [] })])).toEqual({ ok: false, code: 'no_projects' })
    expect(parseChatGPTConversations([])).toEqual({ ok: false, code: 'no_projects' })
  })

  it('takes milliseconds as such and treats an impossible date as none', () => {
    const r = ok([
      conversation({ id: 'ms', created: day('2025-03-14') * 1000, messages: [{ role: 'user', text: 'a' }] }),
      conversation({ id: 'far', created: 1e15, messages: [{ role: 'user', text: 'b', at: 1e30 }] }),
    ])
    const byId = Object.fromEntries(r.projects[0]!.conversations.map((c) => [c.id, c]))
    expect(byId['ms']!.created).toBe(day('2025-03-14'))
    expect(byId['far']!.created).toBe(0)
    expect(() => historyFiles(r.projects[0]!.conversations)).not.toThrow()
    expect(transcript(byId['far']!)).toContain('# Conversation far')
  })

  it('refuses more conversations than the limit', () => {
    const many = Array.from({ length: CHAT_LIMITS.conversations + 1 }, () => ({}))
    expect(parseChatGPTConversations(many)).toEqual({ ok: false, code: 'too_large' })
  })
})

const conv = (id: string, created: number, title = `Talk ${id}`, text = 'hello'): ChatConversation => ({
  id,
  title,
  created,
  updated: created,
  messages: [
    { role: 'user', text, at: created },
    { role: 'assistant', text: 'hi there', at: created + 86400 },
  ],
})

describe('transcript', () => {
  it('writes the title, dates, speakers and a line when the day changes', () => {
    const t = transcript({ ...conv('a', day('2025-03-14')), updated: day('2025-03-15') })
    expect(t).toBe(
      '# Talk a\n\nImported from ChatGPT. Started 2025-03-14, last message 2025-03-15.\n\n### 2025-03-14\n\n**You:**\n\nhello\n\n### 2025-03-15\n\n**ChatGPT:**\n\nhi there\n'
    )
  })

  it('names an untitled conversation', () => {
    expect(transcript({ ...conv('a', 0), title: '' })).toMatch(/^# Untitled conversation\n/)
  })
})

describe('historyFiles', () => {
  it('writes one file per conversation when they fit, oldest first', () => {
    const files = historyFiles([conv('b', day('2025-02-01'), 'Second / talk'), conv('a', day('2025-01-01'), 'First')], 5)
    expect(files.map((f) => f.name)).toEqual(['ChatGPT 2025-01-01 First.md', 'ChatGPT 2025-02-01 Second / talk.md'])
  })

  it('groups by month with an index when there are too many, then by year', () => {
    const convs = [conv('a', day('2025-01-01')), conv('b', day('2025-01-20')), conv('c', day('2025-02-03')), conv('d', day('2026-05-05')), conv('e', day('2026-05-06'))]
    const monthly = historyFiles(convs, 4)
    expect(monthly.map((f) => f.name)).toEqual([INDEX_FILE, 'ChatGPT 2025-01.md', 'ChatGPT 2025-02.md', 'ChatGPT 2026-05.md'])
    expect(monthly[1]!.text.indexOf('# Talk a')).toBeLessThan(monthly[1]!.text.indexOf('# Talk b'))
    expect(monthly[0]!.text).toContain('- 2025-01-20: Talk b (ChatGPT 2025-01.md)')
    expect(monthly[0]!.text.indexOf('Talk d')).toBeLessThan(monthly[0]!.text.indexOf('Talk a'))
    const yearly = historyFiles(convs, 3)
    expect(yearly.map((f) => f.name)).toEqual([INDEX_FILE, 'ChatGPT 2025.md', 'ChatGPT 2026.md'])
  })

  it('splits a file over the size limit into parts', () => {
    const big = conv('a', day('2025-01-01'), 'Big', 'line of text\n'.repeat(400))
    const files = historyFiles([big], 10, 1000)
    expect(files.length).toBeGreaterThan(1)
    expect(files[0]!.name).toBe('ChatGPT 2025-01-01 Big part 1.md')
    for (const f of files) expect(Buffer.byteLength(f.text)).toBeLessThanOrEqual(1000)
    expect(files.map((f) => f.text).join('')).toBe(transcript(big))
  })

  it('cuts a long title so the file name stays short', () => {
    const [f] = historyFiles([conv('a', day('2025-01-01'), 'x'.repeat(300))])
    expect(f!.name.length).toBeLessThanOrEqual(120)
  })

  it('writes nothing for no conversations', () => {
    expect(historyFiles([])).toEqual([])
  })
})

describe('splitText', () => {
  it('never splits a character and keeps every byte', () => {
    const text = 'é'.repeat(1000) + '\n' + '😀'.repeat(500)
    const parts = splitText(text, 333)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(333)
  })
})
