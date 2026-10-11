import { describe, it, expect } from 'vitest'
import { simpleParser } from 'mailparser'
import {
  compose,
  draftMail,
  listInbox,
  makeId,
  parseId,
  readMail,
  replyDraft,
  searchMail,
  sendDraft,
} from '../src/imap/mail.js'
import { fakeMailbox, fakeSender } from './imap-fakes.js'

const OWNER = 'leif@yahoo.com'

async function incoming(extra: Record<string, unknown> = {}): Promise<Buffer> {
  return compose(
    {
      from: 'Jane Doe <jane@example.com>',
      to: [OWNER],
      subject: 'Quarterly numbers',
      body: 'Here are the numbers.\nSecond line.',
      ...extra,
    } as never,
    new Date('2026-10-09T14:00:00Z')
  )
}

describe('message ids', () => {
  it('round-trips folder and uid, splitting on the last colon', () => {
    expect(parseId(makeId('INBOX', 42))).toEqual({ folder: 'INBOX', uid: 42 })
    expect(parseId('Work:Clients:7')).toEqual({ folder: 'Work:Clients', uid: 7 })
  })

  it('rejects ids from somewhere else, in words the owner can act on', () => {
    for (const bad of ['42', 'INBOX:', 'INBOX:abc', ':5', 'INBOX:0', 'AAMkAG...']) {
      expect(() => parseId(bad)).toThrow(/not a message id/)
    }
  })
})

describe('listInbox and searchMail', () => {
  it('lists newest first with folder-qualified ids', async () => {
    const box = fakeMailbox()
    box.put('INBOX', await incoming(), { subject: 'Old', from: 'a@x.com', date: '2026-10-01T10:00:00.000Z' })
    const newer = box.put('INBOX', await incoming(), { subject: 'New', from: 'b@x.com', date: '2026-10-02T10:00:00.000Z', unread: false })
    const out = await listInbox(box, 10)
    expect(out.map((m) => m.subject)).toEqual(['New', 'Old'])
    expect(out[0]).toMatchObject({ id: `INBOX:${newer}`, from: 'b@x.com', unread: false })
  })

  it('caps the count so a wide request cannot pull a mailbox', async () => {
    const box = fakeMailbox()
    await listInbox(box, 999)
    expect(box.calls).toContain('recent INBOX 50')
  })

  it('searches the named folder and refuses an empty query', async () => {
    const box = fakeMailbox()
    box.put('Archive', await incoming({ subject: 'Invoice 7' }), { subject: 'Invoice 7' })
    const out = await searchMail(box, 'invoice', 5, 'Archive')
    expect(out).toHaveLength(1)
    expect(out[0]!.id.startsWith('Archive:')).toBe(true)
    await expect(searchMail(box, '   ')).rejects.toThrow(/something to look for/)
  })
})

describe('readMail', () => {
  it('returns plain text with sender and date', async () => {
    const box = fakeMailbox()
    const uid = box.put('INBOX', await incoming(), {})
    const m = await readMail(box, `INBOX:${uid}`)
    expect(m.subject).toBe('Quarterly numbers')
    expect(m.from).toContain('jane@example.com')
    expect(m.received).toBe('2026-10-09T14:00:00.000Z')
    expect(m.body).toBe('Here are the numbers.\nSecond line.')
  })

  it('derives text from an HTML-only message', async () => {
    const box = fakeMailbox()
    const uid = box.put('INBOX', await incoming({ html: true, body: '<p>Hello <b>there</b></p>' }), {})
    expect((await readMail(box, `INBOX:${uid}`)).body).toMatch(/Hello\s+there/)
  })

  it('says so when the message is gone', async () => {
    await expect(readMail(fakeMailbox(), 'INBOX:999')).rejects.toThrow(/No message INBOX:999/)
  })
})

describe('draftMail', () => {
  it('appends to the Drafts folder flagged as a draft and returns its id', async () => {
    const box = fakeMailbox()
    const d = await draftMail(box, { from: OWNER, to: ['bob@x.com'], subject: 'Hi', body: 'Hello Bob' })
    expect(d.id).toMatch(/^Draft:\d+$/)
    expect(box.calls).toContain('append Draft \\Draft \\Seen')
    const raw = box.folders.get('Draft')![0]!.raw
    const p = await simpleParser(raw)
    expect(p.subject).toBe('Hi')
    expect(p.text?.trim()).toBe('Hello Bob')
  })

  it('reports a null id when the server does not return one', async () => {
    const d = await draftMail(fakeMailbox({ uidplus: false }), { from: OWNER, to: ['b@x.com'], subject: 's', body: 'b' })
    expect(d.id).toBeNull()
  })

  it('refuses when the server names no Drafts folder', async () => {
    await expect(
      draftMail(fakeMailbox({ drafts: null }), { from: OWNER, to: ['b@x.com'], subject: 's', body: 'b' })
    ).rejects.toThrow(/no Drafts folder/)
  })
})

describe('replyDraft', () => {
  it('threads the reply, prefixes Re:, quotes the original and answers the sender', async () => {
    const box = fakeMailbox()
    const uid = box.put('INBOX', await incoming(), {})
    const original = await simpleParser(box.folders.get('INBOX')![0]!.raw)
    const d = await replyDraft(box, OWNER, `INBOX:${uid}`, 'Thanks, Jane.')
    const p = await simpleParser(box.folders.get('Draft')!.find((s) => makeId('Draft', s.uid) === d.id)!.raw)
    expect(p.subject).toBe('Re: Quarterly numbers')
    expect(p.inReplyTo).toBe(original.messageId)
    expect(p.text).toContain('Thanks, Jane.')
    expect(p.text).toContain('> Here are the numbers.')
    expect((p.to as { value: { address: string }[] }).value.map((v) => v.address)).toEqual(['jane@example.com'])
    expect(p.cc).toBeUndefined()
  })

  it('answers Reply-To when the message has one', async () => {
    const box = fakeMailbox()
    const raw = await compose({
      from: 'news@example.com',
      to: [OWNER],
      subject: 'Re: x',
      body: 'b',
    })
    // MailComposer has no replyTo in DraftInput; splice the header in.
    const withReplyTo = Buffer.from(raw.toString().replace(/^From:/m, 'Reply-To: replies@example.com\r\nFrom:'))
    const uid = box.put('INBOX', withReplyTo, {})
    const d = await replyDraft(box, OWNER, `INBOX:${uid}`, 'ok')
    const p = await simpleParser(box.folders.get('Draft')!.find((s) => makeId('Draft', s.uid) === d.id)!.raw)
    expect((p.to as { value: { address: string }[] }).value.map((v) => v.address)).toEqual(['replies@example.com'])
    expect(p.subject).toBe('Re: x')
  })

  it('with all, keeps the other recipients and never the owner', async () => {
    const box = fakeMailbox()
    const uid = box.put('INBOX', await incoming({ to: [OWNER, 'sam@example.com'], cc: ['kim@example.com'] }), {})
    const d = await replyDraft(box, OWNER, `INBOX:${uid}`, 'ok', true)
    const p = await simpleParser(box.folders.get('Draft')!.find((s) => makeId('Draft', s.uid) === d.id)!.raw)
    const cc = (p.cc as { value: { address: string }[] }).value.map((v) => v.address)
    expect(cc).toEqual(['sam@example.com', 'kim@example.com'])
    expect(cc).not.toContain(OWNER)
  })
})

describe('sendDraft', () => {
  async function withDraft() {
    const box = fakeMailbox()
    const d = await draftMail(box, { from: OWNER, to: ['bob@x.com'], cc: ['cat@x.com'], subject: 'Hi', body: 'Hello' })
    return { box, id: d.id! }
  }

  it('refuses without approval and leaves the draft alone', async () => {
    const { box, id } = await withDraft()
    const s = fakeSender()
    await expect(sendDraft(box, s, OWNER, id, false, false)).rejects.toThrow(/explicit approval/)
    expect(s.sent).toHaveLength(0)
    expect(box.folders.get('Draft')).toHaveLength(1)
  })

  it('refuses anything that is not in Drafts', async () => {
    const box = fakeMailbox()
    const uid = box.put('INBOX', await incoming(), {})
    await expect(sendDraft(box, fakeSender(), OWNER, `INBOX:${uid}`, true, false)).rejects.toThrow(/not in Draft/)
  })

  it('sends the stored bytes from the owner to every recipient, files a Sent copy, removes the draft', async () => {
    const { box, id } = await withDraft()
    const stored = box.folders.get('Draft')![0]!.raw
    const s = fakeSender()
    const r = await sendDraft(box, s, OWNER, id, true, false)
    expect(r.recipients).toEqual(['bob@x.com', 'cat@x.com'])
    expect(s.sent[0]!.raw.equals(stored)).toBe(true)
    expect(s.sent[0]!.envelope).toEqual({ from: OWNER, to: ['bob@x.com', 'cat@x.com'] })
    expect(box.folders.get('Sent')).toHaveLength(1)
    expect(box.folders.get('Draft')).toHaveLength(0)
  })

  it('uses the owner as envelope sender even when the draft claims someone else', async () => {
    const box = fakeMailbox()
    const d = await draftMail(box, { from: 'ceo@bank.com', to: ['bob@x.com'], subject: 'Wire', body: 'now' })
    const s = fakeSender()
    await sendDraft(box, s, OWNER, d.id!, true, true)
    expect(s.sent[0]!.envelope.from).toBe(OWNER)
  })

  it('skips the Sent copy when the provider files one itself', async () => {
    const { box, id } = await withDraft()
    await sendDraft(box, fakeSender(), OWNER, id, true, true)
    expect(box.folders.get('Sent')).toBeUndefined()
  })

  it('keeps the draft when the send fails', async () => {
    const { box, id } = await withDraft()
    await expect(sendDraft(box, fakeSender(true), OWNER, id, true, false)).rejects.toThrow(/smtp down/)
    expect(box.folders.get('Draft')).toHaveLength(1)
  })

  it('does not report a failed send when only the bookkeeping fails', async () => {
    const { box, id } = await withDraft()
    box.remove = async () => {
      throw new Error('expunge failed')
    }
    const s = fakeSender()
    await expect(sendDraft(box, s, OWNER, id, true, false)).resolves.toEqual({ recipients: ['bob@x.com', 'cat@x.com'] })
    expect(s.sent).toHaveLength(1)
  })
})
