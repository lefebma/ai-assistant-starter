import { describe, it, expect } from 'vitest'
import { excerpt, gmailQuery, groupGmail, groupOutlook, relatedThreads, MAX_THREADS } from '../src/proactive/threads.js'
import type { UpcomingEvent } from '../src/proactive/calendar.js'

const NOW = Date.parse('2026-10-30T16:00:00Z')
const DAY = 86_400_000

describe('excerpt', () => {
  it('keeps the reply and drops quoted history and signatures', () => {
    const body = [
      'Hi Marc,',
      'Can you confirm the cutover date before Thursday?',
      '',
      'On Tue, Oct 28, 2026 at 9:00 AM Marc wrote:',
      '> earlier text',
    ].join('\n')
    expect(excerpt(body)).toBe('Hi Marc,\nCan you confirm the cutover date before Thursday?')
    expect(excerpt('Short note\n--\nDevon Spencer\nPL')).toBe('Short note')
  })

  it('keeps a forward, whose message is all below its header', () => {
    expect(excerpt('---------- Forwarded message ---------\nFrom: Devon\nPlease review by Friday')).toContain('Please review by Friday')
  })

  it('caps the length', () => {
    expect(excerpt('x'.repeat(5000)).length).toBe(700)
  })
})

describe('gmailQuery', () => {
  it('matches mail from, to or copying any attendee in the lookback', () => {
    expect(gmailQuery(['a@x.com', 'b@y.com'])).toBe(
      'newer_than:14d -in:chats -in:drafts (from:a@x.com OR to:a@x.com OR cc:a@x.com OR from:b@y.com OR to:b@y.com OR cc:b@y.com)'
    )
  })
})

describe('groupGmail', () => {
  const msg = (id: string, thread: string, at: number, labels: string[], from = 'Devon <devon@client.com>', body = 'Body') => ({
    id,
    threadId: thread,
    subject: `Subject ${thread}`,
    from,
    internalDateIso: new Date(at).toISOString(),
    labels,
    body,
  })

  it('groups by thread, newest first, knowing who wrote last', () => {
    const threads = groupGmail(
      [
        msg('m1', 't1', NOW - 3 * DAY, ['INBOX'], 'Devon <devon@client.com>', 'Can you send the plan?'),
        msg('m2', 't1', NOW - 2 * DAY, ['SENT'], 'Me <me@x.com>', 'Will do'),
        msg('m3', 't2', NOW - DAY, ['INBOX'], 'James <james@bdc.ca>', 'Agenda attached'),
        msg('d1', 't3', NOW - DAY, ['DRAFT']),
        msg('old', 't4', NOW - 20 * DAY, ['INBOX']),
      ],
      'me@x.com',
      NOW - 14 * DAY
    )
    expect(threads.map((t) => t.ref)).toEqual(['t2', 't1'])
    const t1 = threads[1]!
    expect(t1.lastFromOwner).toBe(true)
    expect(t1.lastInbound).toMatchObject({ from: 'Devon <devon@client.com>', excerpt: 'Can you send the plan?' })
    expect(t1.messages).toBe(2)
    expect(t1.messageIds.sort()).toEqual(['m1', 'm2'])
    expect(t1.link).toBe('https://mail.google.com/mail/u/me%40x.com/#all/t1')
  })

  it(`keeps at most ${MAX_THREADS} threads`, () => {
    const rows = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `t${i}`, NOW - i * 3_600_000, ['INBOX']))
    expect(groupGmail(rows, 'me@x.com', 0)).toHaveLength(MAX_THREADS)
  })
})

describe('groupOutlook', () => {
  it('groups by conversation and remembers the newest inbound message to read', () => {
    const rows = [
      { id: 'a', conversationId: 'c1', subject: 'Plan', from: { emailAddress: { name: 'James', address: 'james@bdc.ca' } }, receivedDateTime: new Date(NOW - DAY).toISOString(), webLink: 'L1' },
      { id: 'b', conversationId: 'c1', subject: 'RE: Plan', from: { emailAddress: { address: 'Me@Corp.com' } }, receivedDateTime: new Date(NOW - 3_600_000).toISOString(), webLink: 'L2' },
      { id: 'd', conversationId: 'c2', isDraft: true, receivedDateTime: new Date(NOW).toISOString() },
    ]
    const { threads, inboundIds } = groupOutlook(rows, 'me@corp.com', NOW - 14 * DAY)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ ref: 'c1', subject: 'RE: Plan', lastFromOwner: true, link: 'L2' })
    expect(threads[0]!.lastInbound?.from).toBe('James <james@bdc.ca>')
    expect(inboundIds.get('c1')).toBe('a')
  })
})

function event(over: Partial<UpcomingEvent> = {}): UpcomingEvent {
  return {
    account: 'me@x.com',
    provider: 'google',
    id: 'e1',
    seriesKey: 's1',
    title: 'Review',
    startMs: NOW + 3_600_000,
    endMs: NOW + 7_200_000,
    location: '',
    attendees: [{ email: 'devon@client.com', name: 'Devon' }],
    organizer: false,
    link: '',
    ...over,
  }
}

describe('relatedThreads', () => {
  it('runs one Gmail search on the meeting account, with bodies', async () => {
    const calls: string[][] = []
    const exec = async (_bin: string, args: string[]) => {
      calls.push(args)
      return { ok: true, stdout: '[]' }
    }
    await relatedThreads(event(), 'me@x.com', NOW, { exec })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.arrayContaining(['gmail', 'messages', 'search', '--include-body', '--account', 'me@x.com']))
  })

  it('leaves out attendee addresses that could change the search', async () => {
    const calls: string[][] = []
    const exec = async (_bin: string, args: string[]) => {
      calls.push(args)
      return { ok: true, stdout: '[]' }
    }
    await relatedThreads(
      event({ attendees: [{ email: 'x@y.com OR label:secret', name: '' }, { email: 'ok@y.com', name: '' }] }),
      'me@x.com',
      NOW,
      { exec }
    )
    expect(calls[0]![3]).not.toContain('label:secret')
    expect(calls[0]![3]).toContain('from:ok@y.com')
  })

  it('does not search when there is no one to search for', async () => {
    const exec = async () => {
      throw new Error('should not run')
    }
    expect(await relatedThreads(event({ attendees: [] }), 'me@x.com', NOW, { exec })).toEqual([])
  })

  it('throws when the mailbox cannot be read, so the scan tries again later', async () => {
    const exec = async () => ({ ok: false, stdout: '' })
    await expect(relatedThreads(event(), 'me@x.com', NOW, { exec })).rejects.toThrow()
  })

  it('reads Outlook through Graph search and fetches only kept bodies', async () => {
    const paths: string[] = []
    const client = {
      get: async (path: string) => {
        paths.push(path)
        if (path.startsWith('/me/messages?$search')) {
          return {
            value: [
              { id: 'm1', conversationId: 'c1', subject: 'Q', from: { emailAddress: { address: 'devon@client.com' } }, receivedDateTime: new Date(NOW - DAY).toISOString() },
            ],
          }
        }
        return { body: { content: 'Can you confirm?\n\nFrom: me' } }
      },
      post: async () => ({}),
      patch: async () => ({}),
    }
    const threads = await relatedThreads(event({ provider: 'outlook', account: 'default' }), 'me@corp.com', NOW, {
      client: () => client,
    })
    expect(decodeURIComponent(paths[0]!)).toContain('"participants:devon@client.com"')
    expect(paths[1]).toBe('/me/messages/m1?$select=body')
    expect(threads[0]!.lastInbound?.excerpt).toBe('Can you confirm?')
  })
})
