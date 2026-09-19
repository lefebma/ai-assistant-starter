import { describe, it, expect } from 'vitest'
import { searchMail, listInbox, readMail, draftMail, replyDraft, sendDraft, summarise } from '../src/ms/mail.js'

function fake(responses: unknown[] = []) {
  const calls: { method: string; path: string; body?: unknown; headers?: Record<string, string> }[] = []
  let q = [...responses]
  return {
    calls,
    client: {
      get: async (path: string, headers?: Record<string, string>) => { calls.push({ method: 'GET', path, headers }); return q.shift() ?? {} },
      post: async (path: string, body: unknown) => { calls.push({ method: 'POST', path, body }); return q.shift() ?? {} },
      patch: async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return q.shift() ?? {} },
    } as never,
  }
}

const MSG = {
  id: 'AAA',
  subject: 'Invoice',
  from: { emailAddress: { name: 'Jane', address: 'jane@x.com' } },
  receivedDateTime: '2026-09-15T13:00:00Z',
  isRead: false,
  bodyPreview: 'Please find attached',
}

describe('searchMail', () => {
  it('asks Graph for a search and maps the results', async () => {
    const f = fake([{ value: [MSG] }])
    const out = await searchMail(f.client, 'invoice', 5)
    expect(out).toEqual([
      { id: 'AAA', subject: 'Invoice', from: 'Jane <jane@x.com>', received: '2026-09-15T13:00:00Z', unread: true, preview: 'Please find attached' },
    ])
    expect(f.calls[0]!.path).toContain('$search')
    expect(f.calls[0]!.path).toContain('%22invoice%22')
  })

  it('caps the count so a wide search cannot pull a mailbox', async () => {
    const f = fake([{ value: [] }])
    await searchMail(f.client, 'x', 999)
    expect(f.calls[0]!.path).toContain('$top=50')
  })

  it('survives a response with no value array', async () => {
    expect(await searchMail(fake([{}]).client, 'x')).toEqual([])
  })

  it('does not crash on a message missing a sender', async () => {
    const out = await searchMail(fake([{ value: [{ id: 'B', subject: 'S' }] }]).client, 'x')
    expect(out[0]).toMatchObject({ id: 'B', from: 'unknown' })
  })
})

describe('readMail', () => {
  it('fetches one message by id and returns its body', async () => {
    const f = fake([{ ...MSG, body: { contentType: 'text', content: 'full text' } }])
    const out = await readMail(f.client, 'AAA')
    expect(out.body).toBe('full text')
    expect(f.calls[0]!.path).toBe('/me/messages/AAA')
  })

  it('asks for a plain-text body; the HTML one is mostly table markup', async () => {
    const f = fake([{ ...MSG, body: { content: 'x' } }])
    await readMail(f.client, 'AAA')
    expect(f.calls[0]!.headers).toEqual({ Prefer: 'outlook.body-content-type="text"' })
  })

  it('escapes an id so it cannot reach a different path', async () => {
    const f = fake([MSG])
    await readMail(f.client, 'a/b')
    expect(f.calls[0]!.path).toBe('/me/messages/a%2Fb')
  })
})

describe('listInbox', () => {
  it('reads the inbox folder newest first', async () => {
    const f = fake([{ value: [MSG] }])
    const out = await listInbox(f.client, 5)
    expect(f.calls[0]!.path).toContain('/me/mailFolders/inbox/messages')
    expect(f.calls[0]!.path).toContain('$top=5')
    expect(f.calls[0]!.path).toContain('$orderby=receivedDateTime desc')
    expect(out[0]!.subject).toBe('Invoice')
  })

  it('caps the count like search does', async () => {
    const f = fake([{ value: [] }])
    await listInbox(f.client, 500)
    expect(f.calls[0]!.path).toContain('$top=50')
  })
})

describe('draftMail', () => {
  it('creates a draft rather than sending', async () => {
    const f = fake([{ id: 'D1' }])
    const out = await draftMail(f.client, { to: ['a@b.com'], subject: 'Hi', body: 'Body' })
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/me/messages' })
    expect(out.id).toBe('D1')
  })

  it('defaults to plain text, because html bodies render markdown literally', async () => {
    const f = fake([{ id: 'D1' }])
    await draftMail(f.client, { to: ['a@b.com'], subject: 'S', body: 'B' })
    expect((f.calls[0]!.body as never as { body: { contentType: string } }).body.contentType).toBe('Text')
  })

  it('sends html when asked', async () => {
    const f = fake([{ id: 'D1' }])
    await draftMail(f.client, { to: ['a@b.com'], subject: 'S', body: '<b>B</b>', html: true })
    expect((f.calls[0]!.body as never as { body: { contentType: string } }).body.contentType).toBe('HTML')
  })

  it('accepts an empty recipient list, so a draft can be addressed later', async () => {
    const f = fake([{ id: 'D1' }])
    await draftMail(f.client, { to: [], subject: 'S', body: 'B' })
    expect((f.calls[0]!.body as never as { toRecipients: unknown[] }).toRecipients).toEqual([])
  })
})

describe('replyDraft', () => {
  it('saves the reply as a draft in the thread', async () => {
    const f = fake([{ id: 'R1' }])
    const out = await replyDraft(f.client, 'AAA', 'Thanks, will do.')
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/me/messages/AAA/createReply', body: { comment: 'Thanks, will do.' } })
    expect(out.id).toBe('R1')
  })

  it('answers everyone when asked', async () => {
    const f = fake([{ id: 'R1' }])
    await replyDraft(f.client, 'AAA', 'x', true)
    expect(f.calls[0]!.path).toBe('/me/messages/AAA/createReplyAll')
  })
})

describe('sendDraft', () => {
  it('refuses without an explicit approval flag, and touches nothing', async () => {
    const f = fake()
    await expect(sendDraft(f.client, 'D1', false)).rejects.toThrow(/approv/i)
    expect(f.calls).toHaveLength(0)
  })

  it('sends the existing draft, so what leaves is what was reviewed', async () => {
    const f = fake([{}])
    await sendDraft(f.client, 'D1', true)
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/me/messages/D1/send' })
  })

  it('will not send without a draft id', async () => {
    await expect(sendDraft(fake().client, '  ', true)).rejects.toThrow(/draft id/i)
  })
})

describe('summarise', () => {
  it('renders a list a person can read in a chat window', () => {
    const out = summarise([
      { id: 'AAA', subject: 'Invoice', from: 'Jane <jane@x.com>', received: '2026-09-15T13:00:00Z', unread: true, preview: 'hi' },
    ])
    expect(out).toContain('Invoice')
    expect(out).toContain('Jane')
    expect(out).toContain('AAA')
  })

  it('says so plainly when nothing matched', () => {
    expect(summarise([])).toMatch(/no messages/i)
  })

  it("shows the received time in the owner's zone, not UTC", () => {
    const out = summarise(
      [{ id: 'A', subject: 'S', from: 'x', received: '2026-09-15T13:00:00Z', unread: false, preview: '' }],
      'America/Toronto'
    )
    expect(out).toContain('2026-09-15 09:00')
    expect(out).not.toContain('13:00')
  })
})
