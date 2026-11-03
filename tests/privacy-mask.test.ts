/**
 * The anonymizer's engine and its two wire formats (card #187): masking,
 * restoring, streamed replies split mid-placeholder, the Messages API shape
 * the Claude CLI sends, and the ai-sdk middleware.
 */
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { generateText, simulateReadableStream, streamText, wrapLanguageModel } from 'ai'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { Masker, PRIVACY_NOTE, PrivacyRefusal, findContactDetails, pendingTail, type Entry } from '../src/privacy/mask.js'
import { maskRequest, requestTexts, restoreResponse, SseRestorer } from '../src/privacy/anthropic.js'
import { privacyMiddleware } from '../src/privacy/middleware.js'

const ENTRIES: Entry[] = [
  { id: 1, kind: 'company', value: 'Acme Corporation', aliases: ['Acme'] },
  { id: 2, kind: 'person', value: 'Jane Smith', aliases: [] },
  { id: 3, kind: 'email', value: 'jane@acme.com', aliases: [] },
  { id: 4, kind: 'phone', value: '(416) 555-0199', aliases: [] },
  { id: 5, kind: 'person', value: "Seán O'Brien", aliases: [] },
]
const m = new Masker(ENTRIES)

describe('mask', () => {
  it('swaps names and companies for placeholders', () => {
    expect(m.mask('Jane Smith runs Acme Corporation.')).toBe('PERSON_2 runs COMPANY_1.')
  })

  it('matches any case, extra spaces and line breaks, and possessives', () => {
    expect(m.mask('JANE  smith and acme\ncorporation')).toBe('PERSON_2 and COMPANY_1')
    expect(m.mask("Acme's invoice")).toBe("COMPANY_1's invoice")
  })

  it('prefers the longest form, then catches the alias', () => {
    expect(m.mask('Acme Corporation, also called Acme.')).toBe('COMPANY_1, also called COMPANY_1.')
  })

  it('leaves a word that only contains a name alone (partial match)', () => {
    expect(m.mask('Acmeville and Jane Smithson and the acmes')).toBe('Acmeville and Jane Smithson and the acmes')
  })

  it('handles names with accents and apostrophes', () => {
    expect(m.mask("Call Seán O'Brien today")).toBe('Call PERSON_5 today')
  })

  it('leaves a name that is not on the list as it is (the miss case)', () => {
    expect(m.mask('Bob Jones at Initech')).toBe('Bob Jones at Initech')
  })

  it('swaps an email whole before names, and any spelling of a phone number', () => {
    expect(m.mask('Write to jane@acme.com or JANE@ACME.COM')).toBe('Write to EMAIL_3 or EMAIL_3')
    expect(m.mask('Call 416-555-0199 or +1 416 555 0199')).toBe('Call PHONE_4 or PHONE_4')
  })

  it('does nothing with an empty list', () => {
    expect(new Masker([]).mask('Jane Smith')).toBe('Jane Smith')
  })
})

describe('spellings', () => {
  const q = new Masker([
    { id: 8, kind: 'person', value: 'José Álvarez', aliases: [] },
    { id: 9, kind: 'person', value: "Sean O'Brien", aliases: [] },
    { id: 10, kind: 'company', value: 'Smith-Jones', aliases: [] },
    { id: 11, kind: 'company', value: 'Ünal', aliases: [] },
  ])
  it('matches accented names in either Unicode form', () => {
    expect(q.mask('José Álvarez'.normalize('NFD'))).toBe('PERSON_8')
    expect(q.mask('JOSÉ ÁLVAREZ')).toBe('PERSON_8')
  })
  it('treats curly apostrophes and any dash as the same', () => {
    expect(q.mask('Sean O\u2019Brien and Smith\u2013Jones')).toBe('PERSON_9 and COMPANY_10')
  })
  it('keeps whole-word matching for names starting with an accented letter', () => {
    expect(q.mask('Ünal and XÜnal and Ünalco')).toBe('COMPANY_11 and XÜnal and Ünalco')
  })
})

describe('restore', () => {
  it('puts the real values back', () => {
    expect(m.restore('PERSON_2 at COMPANY_1 (EMAIL_3)')).toBe('Jane Smith at Acme Corporation (jane@acme.com)')
  })

  it('round-trips', () => {
    const text = 'Jane Smith of Acme Corporation, jane@acme.com'
    expect(m.restore(m.mask(text))).toBe(text)
  })

  it('leaves unknown or mismatched placeholders and ordinary capitals alone', () => {
    expect(m.restore('PERSON_99, COMPANY_2, PERSONAL_1, XPERSON_2, NASA')).toBe('PERSON_99, COMPANY_2, PERSONAL_1, XPERSON_2, NASA')
  })

  it('escapes for a JSON string when asked', () => {
    const q = new Masker([{ id: 7, kind: 'company', value: 'The "Best" Co', aliases: [] }])
    expect(q.restore('{"to":"COMPANY_7"}', true)).toBe('{"to":"The \\"Best\\" Co"}')
    expect(JSON.parse(q.restore('{"to":"COMPANY_7"}', true)).to).toBe('The "Best" Co')
  })
})

describe('a scope for one request', () => {
  it('restores only placeholders its own masking produced (no restore oracle)', () => {
    const s = m.scope()
    const sent = s.mask('Hello Jane Smith, typed by hand: COMPANY_1 and EMAIL_3')
    expect(sent).toBe('Hello PERSON_2, typed by hand: COMPANY_1 and EMAIL_3')
    expect(s.restore('PERSON_2, COMPANY_1, EMAIL_3')).toBe('Jane Smith, COMPANY_1, EMAIL_3')
    const r = s.stream()
    expect(r.push('Hi PERS') + r.push('ON_2 of COMPANY_1') + r.flush()).toBe('Hi Jane Smith of COMPANY_1')
  })

  it('restores to the words this request used, never a fuller spelling', () => {
    const s = m.scope()
    s.mask('Ask acme about JANE@ACME.COM')
    expect(s.restore('COMPANY_1 and EMAIL_3')).toBe('acme and JANE@ACME.COM')
    const both = m.scope()
    both.mask('Acme, also known as Acme Corporation')
    expect(both.restore('COMPANY_1')).toBe('Acme Corporation')
  })

  it('does not reveal a name through a streamed Messages reply either', () => {
    const s = m.scope()
    maskRequest({ messages: [{ role: 'user', content: 'Who is COMPANY_1? Ask Jane Smith.' }] }, s)
    const r = new SseRestorer(s)
    const out = r.feed(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'COMPANY_1 per PERSON_2' } },
      { type: 'content_block_stop', index: 0 },
    ]))
    expect(parseSse(out).filter((e) => e.delta).map((e) => e.delta.text).join('')).toBe('COMPANY_1 per Jane Smith')
  })
})

describe('streamed restore', () => {
  it('holds back a tail that could still become a placeholder', () => {
    expect(pendingTail('Hello PERS')).toBe('PERS')
    expect(pendingTail('Hello COMPANY_')).toBe('COMPANY_')
    expect(pendingTail('Hello PHONE_4')).toBe('PHONE_4')
    expect(pendingTail('Hello NASA')).toBe('')
    expect(pendingTail('xPERS')).toBe('')
    expect(pendingTail('done.')).toBe('')
  })

  it('restores a placeholder split across pieces, in every split', () => {
    const full = 'Dear PERSON_2, thanks from COMPANY_1.'
    for (let i = 1; i < full.length; i++) {
      const r = m.stream()
      const out = r.push(full.slice(0, i)) + r.push(full.slice(i)) + r.flush()
      expect(out).toBe('Dear Jane Smith, thanks from Acme Corporation.')
    }
  })

  it('does not stop at PERSON_1 when PERSON_12 is coming', () => {
    const q = new Masker([{ id: 1, kind: 'person', value: 'One', aliases: [] }, { id: 12, kind: 'person', value: 'Twelve', aliases: [] }])
    const r = q.stream()
    expect(r.push('hi PERSON_1') + r.push('2 there') + r.flush()).toBe('hi Twelve there')
  })
})

describe('contact details', () => {
  it('finds international numbers written with a + country code', () => {
    expect(findContactDetails('+44 20 7946 0958 and +33 1 23 45 67 89').map((c) => c.value)).toEqual(['+44 20 7946 0958', '+33 1 23 45 67 89'])
  })

  it('finds emails and phones, not dates or long ids', () => {
    const found = findContactDetails('a@b.co, (437) 224-2640, 2026-11-03, order 1234567890123')
    expect(found).toEqual([{ kind: 'email', value: 'a@b.co' }, { kind: 'phone', value: '(437) 224-2640' }])
  })
})

describe('Messages API requests', () => {
  const body = {
    model: 'claude-x',
    system: [{ type: 'text', text: 'You help Jane Smith.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'send_to_Acme', description: 'Acme tool', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Email Acme Corporation' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'PERSON_2 asked', signature: 'sig' },
          { type: 'text', text: 'Sure, Jane Smith.' },
          { type: 'tool_use', id: 'tu_1', name: 'send_email', input: { to: 'jane@acme.com', name: 'Jane Smith' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'Sent to Jane Smith' }] }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Acme' } }] },
    ],
  }

  it('masks prose and tool data, and leaves thinking, images, tools, names and ids alone', () => {
    const out = maskRequest(body, m) as any
    expect(out.system[0]).toEqual({ type: 'text', text: 'You help PERSON_2.', cache_control: { type: 'ephemeral' } })
    expect(out.system.at(-1)).toEqual({ type: 'text', text: PRIVACY_NOTE })
    expect(out.tools).toEqual(body.tools)
    expect(out.messages[0].content).toBe('Email COMPANY_1')
    expect(out.messages[1].content[0]).toEqual(body.messages[1].content[0])
    expect(out.messages[1].content[1].text).toBe('Sure, PERSON_2.')
    expect(out.messages[1].content[2]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'send_email', input: { to: 'EMAIL_3', name: 'PERSON_2' } })
    expect(out.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'Sent to PERSON_2' }] })
    expect(out.messages[2].content[1]).toEqual(body.messages[2].content[1])
  })

  it('leaves no listed name anywhere in what goes out, except where the API needs it unchanged', () => {
    const out = JSON.stringify(maskRequest({ ...body, tools: [] }, m))
    expect(out.match(/Jane Smith|Acme Corporation|jane@acme\.com/g)).toBeNull()
  })

  it('masks object keys in tool inputs too', () => {
    const out = maskRequest({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n', input: { 'Acme Corporation': { id: 'Jane Smith' } } }] }] }, m) as any
    expect(out.messages[0].content[0].input).toEqual({ COMPANY_1: { id: 'PERSON_2' } })
  })

  it('leaves out earlier thinking that names someone, and refuses it in a running tool loop', () => {
    const thinking = { type: 'thinking', thinking: 'Jane Smith again', signature: 's' }
    const done = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [thinking, { type: 'text', text: 'ok' }] },
        { role: 'user', content: 'and now?' },
      ],
    }
    const out = maskRequest(done, m) as any
    expect(out.messages[1].content).toEqual([{ type: 'text', text: 'ok' }])
    const looping = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [thinking, { type: 'tool_use', id: 't', name: 'n', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }] },
      ],
    }
    expect(() => maskRequest(looping, m)).toThrow(PrivacyRefusal)
    const clean = { ...looping, messages: looping.messages.map((x, i) => (i === 1 ? { ...x, content: [{ type: 'thinking', thinking: 'PERSON_2', signature: 's' }, x.content[1]] } : x)) }
    expect(() => maskRequest(clean, m)).not.toThrow()
  })

  it('adds the note to a plain string system prompt or to none', () => {
    expect((maskRequest({ system: 'Hi Acme', messages: [] }, m) as any).system).toEqual([{ type: 'text', text: 'Hi COMPANY_1' }, { type: 'text', text: PRIVACY_NOTE }])
    expect((maskRequest({ messages: [] }, m) as any).system).toEqual([{ type: 'text', text: PRIVACY_NOTE }])
  })

  it('lists every text for the contact scan', () => {
    expect(requestTexts(body)).toContain('Sent to Jane Smith')
  })

  it('restores a whole response', () => {
    const res = { content: [{ type: 'text', text: 'Hi PERSON_2' }, { type: 'tool_use', id: 'x', name: 'n', input: { to: 'EMAIL_3' } }, { type: 'thinking', thinking: 'PERSON_2' }] }
    expect(restoreResponse(res, m)).toEqual({ content: [{ type: 'text', text: 'Hi Jane Smith' }, { type: 'tool_use', id: 'x', name: 'n', input: { to: 'jane@acme.com' } }, { type: 'thinking', thinking: 'PERSON_2' }] })
  })
})

function sse(events: object[]): string {
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function parseSse(text: string): any[] {
  return text.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data: '))!.slice(6)))
}

describe('streamed Messages responses', () => {
  const stream = sse([
    { type: 'message_start', message: { id: 'm' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PERSON_2' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello PERS' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ON_2 at COMPANY_' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '1' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'send', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"to": "EMA' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'IL_3"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_stop' },
  ])

  function run(chunkSize: number): any[] {
    const r = new SseRestorer(m)
    let out = ''
    for (let i = 0; i < stream.length; i += chunkSize) out += r.feed(stream.slice(i, i + chunkSize))
    return parseSse(out + r.end())
  }

  for (const size of [1, 7, 64, 100000]) {
    it(`restores text and tool input, in chunks of ${size}`, () => {
      const events = run(size)
      const text = events.filter((e) => e.index === 1 && e.type === 'content_block_delta').map((e) => e.delta.text).join('')
      expect(text).toBe('Hello Jane Smith at Acme Corporation')
      const json = events.filter((e) => e.index === 2 && e.type === 'content_block_delta').map((e) => e.delta.partial_json).join('')
      expect(JSON.parse(json)).toEqual({ to: 'jane@acme.com' })
      // Thinking passes untouched; every block still stops after its last delta.
      expect(events.find((e) => e.delta?.type === 'thinking_delta').delta.thinking).toBe('PERSON_2')
      const stops = events.map((e, i) => (e.type === 'content_block_stop' ? i : -1)).filter((i) => i >= 0)
      for (const s of stops) expect(events.slice(s + 1).some((e) => e.type === 'content_block_delta' && e.index === events[s].index)).toBe(false)
      expect(events.at(-1).type).toBe('message_stop')
    })
  }
})

describe('ai-sdk middleware', () => {
  const pick = () => m

  it('masks the prompt, adds the note after the system prompt, and keeps reasoning', async () => {
    let seen: any
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen = opts.prompt
        return { content: [{ type: 'text', text: 'Hi PERSON_2' }, { type: 'tool-call', toolCallId: 'c', toolName: 'mail', input: '{"to":"EMAIL_3"}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] } as any
      },
    })
    const wrapped = wrapLanguageModel({ model, middleware: privacyMiddleware(pick) })
    const r = await generateText({
      model: wrapped,
      system: 'Assist Jane Smith',
      messages: [
        { role: 'user', content: 'Call Acme Corporation' },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'PERSON_2 asked' }, { type: 'text', text: 'Jane Smith' }] },
        { role: 'user', content: 'ok, mail jane@acme.com' },
      ],
    })
    expect(seen[0]).toMatchObject({ role: 'system', content: 'Assist PERSON_2' })
    expect(seen[1]).toMatchObject({ role: 'system', content: PRIVACY_NOTE })
    expect(seen[2].content[0].text).toBe('Call COMPANY_1')
    expect(seen[3].content[0]).toMatchObject({ type: 'reasoning', text: 'PERSON_2 asked' })
    expect(seen[3].content[1].text).toBe('PERSON_2')
    expect(r.text).toBe('Hi Jane Smith')
    expect(r.toolCalls[0]?.input).toEqual({ to: 'jane@acme.com' })
  })

  it('masks every field of tool inputs and tool results, keys included', async () => {
    let seen: any
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen = opts.prompt
        return { content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'mail', input: '{"id":"PERSON_2","data":{"url":"mailto:EMAIL_3"}}' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] } as any
      },
    })
    const r = await generateText({
      model: wrapLanguageModel({ model, middleware: privacyMiddleware(pick) }),
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'look', input: { id: 'Acme Corporation', url: 'https://x/Acme', data: { owner: 'jane@acme.com' } } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'look', output: { type: 'json', value: { data: [{ name: 'Jane Smith', email: 'jane@acme.com' }], Acme: 1 } } }] },
      ],
    })
    const out = JSON.stringify(seen)
    expect(out).not.toMatch(/Acme|Jane Smith|jane@acme/)
    expect(seen[2].content[0].input).toEqual({ id: 'COMPANY_1', url: 'https://x/COMPANY_1', data: { owner: 'EMAIL_3' } })
    expect(seen[3].content[0].output.value).toEqual({ data: [{ name: 'PERSON_2', email: 'EMAIL_3' }], COMPANY_1: 1 })
    expect(r.toolCalls[0]?.input).toEqual({ id: 'Jane Smith', data: { url: 'mailto:jane@acme.com' } })
  })

  it('masks a part type it does not know, ids aside', async () => {
    let seen: any
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen = opts.prompt
        return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] } as any
      },
    })
    const mw = privacyMiddleware(pick)
    await mw.transformParams!({ type: 'generate', model, params: { prompt: [{ role: 'user', content: [{ type: 'future-part', id: 'Acme', note: 'for Jane Smith' } as any] }] } as any }).then((p: any) => (seen = p.prompt))
    expect(seen.find((x: any) => x.role === 'user').content[0]).toEqual({ type: 'future-part', id: 'Acme', note: 'for PERSON_2' })
  })

  it('refuses a running tool loop whose reasoning names someone', async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error('must not be called') } })
    await expect(generateText({
      model: wrapLanguageModel({ model, middleware: privacyMiddleware(pick) }),
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'Jane Smith' }, { type: 'tool-call', toolCallId: 'c', toolName: 'look', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'look', output: { type: 'text', value: 'ok' } }] },
      ],
    })).rejects.toThrow(/privacy filter/)
  })

  it('restores a streamed reply split mid-placeholder, and streamed tool input', async () => {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'Dear PER' },
      { type: 'text-delta', id: '1', delta: 'SON_2 of COMPANY_1' },
      { type: 'text-end', id: '1' },
      { type: 'tool-input-start', id: 't', toolName: 'mail' },
      { type: 'tool-input-delta', id: 't', delta: '{"to":"EMAIL_' },
      { type: 'tool-input-delta', id: 't', delta: '3"}' },
      { type: 'tool-input-end', id: 't' },
      { type: 'tool-call', toolCallId: 't', toolName: 'mail', input: '{"to":"EMAIL_3"}' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } } as any,
    ]
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) })
    const r = streamText({ model: wrapLanguageModel({ model, middleware: privacyMiddleware(pick) }), prompt: 'hi Jane Smith of Acme Corporation, jane@acme.com' })
    let text = ''
    let input = ''
    let call: unknown
    for await (const p of r.fullStream) {
      if (p.type === 'text-delta') text += p.text
      if (p.type === 'tool-input-delta') input += p.delta
      if (p.type === 'tool-call') call = p.input
    }
    expect(text).toBe('Dear Jane Smith of Acme Corporation')
    expect(JSON.parse(input)).toEqual({ to: 'jane@acme.com' })
    expect(call).toEqual({ to: 'jane@acme.com' })
  })
})
