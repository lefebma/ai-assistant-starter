import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverMailboxes, gmailMailbox, outlookMailbox, type Exec } from '../src/email-alerts/sources.js'

const T = (iso: string) => Date.parse(iso)

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url')
}

const row = (id: string, date: string) => `${id}\t${date}\tAlice <a@x.com>\tHello\tINBOX,UNREAD\tthread1`
const SEARCH_HEADER = 'ID\tDATE\tFROM\tSUBJECT\tLABELS\tTHREAD'

function rawMsg(id: string, internalMs: number, headers: [string, string][], text = 'hi there') {
  return JSON.stringify({
    id,
    internalDate: String(internalMs),
    payload: {
      mimeType: 'multipart/alternative',
      headers: headers.map(([name, value]) => ({ name, value })),
      parts: [
        { mimeType: 'text/plain', body: { data: b64(text) } },
        { mimeType: 'text/html', body: { data: b64('<p>x</p>') } },
      ],
    },
  })
}

afterEach(() => vi.useRealTimers())

describe('gmail source', () => {
  it('gmail list maps rows and headers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T('2026-10-19T12:00:00Z'))
    const calls: string[][] = []
    const exec: Exec = async (_bin, args) => {
      calls.push(args)
      if (args[1] === 'search') {
        return { ok: true, stdout: `${SEARCH_HEADER}\n${row('18c0000000000001', '2026-10-18 09:00')}\n` }
      }
      return {
        ok: true,
        stdout: rawMsg('18c0000000000001', T('2026-10-18T13:00:00Z'), [
          ['From', 'Alice <a@x.com>'],
          ['Subject', 'Hello'],
          ['list-unsubscribe', '<mailto:u@x.com>'],
          ['Message-ID', '<abc@x.com>'],
        ]),
      }
    }
    const box = gmailMailbox('me@gmail.com', exec)
    const out = await box.list(T('2026-10-18T00:00:00Z'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      mailbox: 'me@gmail.com',
      msgId: '18c0000000000001',
      rfcMessageId: '<abc@x.com>',
      subject: 'Hello',
      receivedAt: T('2026-10-18T13:00:00Z'),
    })
    expect(out[0]!.headers.from).toBe('Alice <a@x.com>')
    expect(out[0]!.headers.listUnsubscribe).toBe('<mailto:u@x.com>')
    expect(calls[0]).toEqual(
      expect.arrayContaining(['gmail', 'search', 'in:inbox newer_than:2d', '--plain', '--max', '100', '--account', 'me@gmail.com'])
    )
  })

  it('derives newer_than from sinceMs for older windows', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_b, args) => {
      calls.push(args)
      return { ok: true, stdout: SEARCH_HEADER + '\n' }
    }
    const now = Date.now()
    await gmailMailbox('me@gmail.com', exec).list(now - 14 * 86_400_000)
    expect(calls[0]!.some((a) => /^in:inbox newer_than:1[45]d$/.test(a))).toBe(true)
    await gmailMailbox('me@gmail.com', exec).list(now - 60_000)
    expect(calls[1]!.some((a) => a === 'in:inbox newer_than:1d')).toBe(true)
  })

  it('gmail thread search does not leak older messages', async () => {
    const reads: string[] = []
    const exec: Exec = async (_bin, args) => {
      if (args[1] === 'search') {
        return {
          ok: true,
          stdout: `${SEARCH_HEADER}\n${row('18c0000000000002', '2026-10-01 09:00')}\n${row('18c0000000000003', '2026-10-18 10:00')}\n`,
        }
      }
      reads.push(args[2]!)
      return { ok: true, stdout: rawMsg(args[2]!, T('2026-10-18T14:00:00Z'), [['From', 'a@x.com'], ['Subject', 'S']]) }
    }
    const out = await gmailMailbox('me@gmail.com', exec).list(T('2026-10-17T00:00:00Z'))
    expect(out.map((m) => m.msgId)).toEqual(['18c0000000000003'])
    expect(reads).toEqual(['18c0000000000003'])
  })

  it('a failed per-message read skips that message only', async () => {
    const exec: Exec = async (_b, args) => {
      if (args[1] === 'search') {
        return { ok: true, stdout: `${SEARCH_HEADER}\n${row('18c0000000000004', '2026-10-18 09:00')}\n${row('18c0000000000005', '2026-10-18 10:00')}\n` }
      }
      if (args[2] === '18c0000000000004') return { ok: false, stdout: '' }
      return { ok: true, stdout: rawMsg(args[2]!, T('2026-10-18T14:00:00Z'), [['From', 'a@x.com'], ['Subject', 'S']]) }
    }
    const out = await gmailMailbox('me@gmail.com', exec).list(T('2026-10-17T00:00:00Z'))
    expect(out.map((m) => m.msgId)).toEqual(['18c0000000000005'])
  })

  it('gmail body returns decoded plain text, cleaned', async () => {
    const exec: Exec = async () => ({
      ok: true,
      stdout: rawMsg('18c0000000000001', 0, [['From', 'a@x.com']], 'Line one\r\n\r\n\r\n\r\nLine two'),
    })
    const body = await gmailMailbox('me@gmail.com', exec).body('18c0000000000001')
    expect(body).toBe('Line one\n\nLine two')
  })

  it('a failed search throws so discovery can mark it broken', async () => {
    const exec: Exec = async () => ({ ok: false, stdout: '' })
    await expect(gmailMailbox('me@gmail.com', exec).list(0)).rejects.toThrow()
  })
})

describe('outlook source', () => {
  const inbox = {
    value: [
      { id: 'AAA', subject: 'Invoice', from: { emailAddress: { name: 'Bob', address: 'b@y.com' } }, receivedDateTime: '2026-10-18T12:00:00Z', isRead: false, bodyPreview: 'p' },
      { id: 'OLD', subject: 'Old', from: { emailAddress: { address: 'c@y.com' } }, receivedDateTime: '2026-10-01T12:00:00Z', isRead: false, bodyPreview: '' },
    ],
  }
  const client = {
    async get(path: string) {
      if (path.includes('/mailFolders/inbox/messages')) return inbox
      if (path.includes('internetMessageHeaders')) {
        return {
          internetMessageId: '<rfc1@y.com>',
          internetMessageHeaders: [
            { name: 'LIST-UNSUBSCRIBE', value: '<https://u>' },
            { name: 'Precedence', value: 'bulk' },
          ],
        }
      }
      return { id: 'AAA', subject: 'Invoice', body: { content: 'Pay​  now' } }
    },
    async post() { return {} },
    async patch() { return {} },
  }

  it('outlook list maps internetMessageId to rfcMessageId', async () => {
    const out = await outlookMailbox('o@y.com', client).list(T('2026-10-17T00:00:00Z'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      mailbox: 'o@y.com',
      msgId: 'AAA',
      rfcMessageId: '<rfc1@y.com>',
      subject: 'Invoice',
      receivedAt: T('2026-10-18T12:00:00Z'),
    })
    expect(out[0]!.headers).toMatchObject({ from: 'Bob <b@y.com>', listUnsubscribe: '<https://u>', precedence: 'bulk' })
  })

  it('a failed per-message header fetch skips that message only', async () => {
    const two = {
      value: [
        { id: 'BAD', subject: 'a', receivedDateTime: '2026-10-18T12:00:00Z' },
        { id: 'GOOD', subject: 'b', receivedDateTime: '2026-10-18T12:30:00Z' },
      ],
    }
    const c = {
      async get(path: string) {
        if (path.includes('/mailFolders/inbox/messages')) return two
        if (path.includes('/BAD')) throw new Error('Graph 500')
        return { internetMessageId: '<g@y.com>', internetMessageHeaders: [] }
      },
      async post() { return {} },
      async patch() { return {} },
    }
    const out = await outlookMailbox('o@y.com', c).list(T('2026-10-17T00:00:00Z'))
    expect(out.map((m) => m.msgId)).toEqual(['GOOD'])
  })

  it('outlook body is cleaned', async () => {
    expect(await outlookMailbox('o@y.com', client).body('AAA')).toBe('Pay now')
  })
})

describe('discoverMailboxes', () => {
  const okClient = {
    async get() { return { value: [] } },
    async post() { return {} },
    async patch() { return {} },
  }
  const authList = [
    'EMAIL\tCLIENT\tSERVICES\tCREATED\tAUTH',
    'me@gmail.com\tdefault\tgmail,calendar\t2026-01-01T00:00:00Z\toauth',
    'cal@only.com\tdefault\tcalendar,drive\t2026-01-01T00:00:00Z\toauth',
  ].join('\n')

  it('discover lists gmail and outlook accounts', async () => {
    const exec: Exec = async (_b, args) => {
      if (args[0] === 'auth') return { ok: true, stdout: authList }
      return { ok: true, stdout: SEARCH_HEADER + '\n' }
    }
    const { boxes, broken } = await discoverMailboxes({ exec, msAccounts: () => ['o@y.com'], client: () => okClient })
    expect(boxes.map((b) => `${b.provider}:${b.id}`)).toEqual(['gmail:me@gmail.com', 'outlook:o@y.com'])
    expect(broken).toEqual([])
  })

  it('one failing mailbox is reported as broken, others returned', async () => {
    const exec: Exec = async (_b, args) => {
      if (args[0] === 'auth') return { ok: true, stdout: authList }
      return { ok: false, stdout: '' }
    }
    const badClient = { ...okClient, async get(): Promise<unknown> { throw new Error('Graph 401') } }
    const { boxes, broken } = await discoverMailboxes({ exec, msAccounts: () => ['o@y.com'], client: () => badClient })
    expect(boxes.map((b) => b.id)).toEqual([])
    expect(broken.map((b) => b.id).sort()).toEqual(['me@gmail.com', 'o@y.com'])
    expect(broken.find((b) => b.id === 'me@gmail.com')!.why).toBe('Gmail needs reconnecting for me@gmail.com.')
    expect(broken.find((b) => b.id === 'o@y.com')!.why).toBe('Outlook needs reconnecting for o@y.com.')
  })

  it('discovery probes without any per-message fetch', async () => {
    const calls: string[][] = []
    const exec: Exec = async (_b, args) => {
      calls.push(args)
      if (args[0] === 'auth') return { ok: true, stdout: authList }
      return { ok: true, stdout: `${SEARCH_HEADER}\n${row('18c0000000000001', '2026-10-18 09:00')}\n` }
    }
    const gets: string[] = []
    const c = { ...okClient, async get(p: string) { gets.push(p); return { value: [{ id: 'X', receivedDateTime: new Date().toISOString() }] } } }
    const { boxes } = await discoverMailboxes({ exec, msAccounts: () => ['o@y.com'], client: () => c })
    expect(boxes).toHaveLength(2)
    expect(calls.some((a) => a[1] === 'raw')).toBe(false)
    expect(gets.every((p) => !p.includes('internetMessageHeaders'))).toBe(true)
  })

  it('a failing gog account list yields no gmail boxes and no throw', async () => {
    const exec: Exec = async () => ({ ok: false, stdout: '' })
    const { boxes, broken } = await discoverMailboxes({ exec, msAccounts: () => [] })
    expect(boxes).toEqual([])
    expect(broken).toEqual([])
  })
})
