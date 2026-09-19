import { describe, it, expect } from 'vitest'
import { runAuth, runMail, runCalendar, AUTH_USAGE, type CliDeps } from '../src/ms/cli.js'

type Reply = { status: number; body: unknown }

/**
 * A whole world for the commands: a vault, a clock that sleep advances, and a
 * network that answers the device-code, token and Graph endpoints separately.
 */
function world(opts: {
  vault?: Record<string, string>
  tokenReplies?: Reply[]
  graph?: (url: string, method: string, body: unknown) => Reply
  env?: Record<string, string | undefined>
} = {}) {
  const data = new Map(Object.entries(opts.vault ?? {}))
  const tokenQueue = [...(opts.tokenReplies ?? [])]
  const graphCalls: { url: string; method: string; body: unknown; auth?: string }[] = []
  const printed: string[] = []
  const sleeps: number[] = []
  let clock = 1_000_000_000
  const reply = (r: Reply) => ({ ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) })
  const deps: CliDeps = {
    env: opts.env ?? { MS_CLIENT_ID: 'cid' },
    timeZone: 'America/Toronto',
    vault: {
      get: (n) => data.get(n),
      set: (n, v) => void data.set(n, v),
      delete: (n) => data.delete(n),
      list: () => [...data.keys()],
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/devicecode')) {
        return reply({
          status: 200,
          body: { device_code: 'DEV', user_code: 'ABC-123', verification_uri: 'https://microsoft.com/devicelogin', interval: 5, expires_in: 900 },
        })
      }
      if (url.endsWith('/token')) return reply(tokenQueue.shift() ?? { status: 400, body: { error: 'authorization_pending' } })
      const body = init?.body ? JSON.parse(init.body) : undefined
      graphCalls.push({ url, method: init?.method ?? 'GET', body, auth: init?.headers?.['Authorization'] })
      return reply(opts.graph?.(url, init?.method ?? 'GET', body) ?? { status: 200, body: {} })
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    print: (t) => void printed.push(t),
  }
  return { deps, data, graphCalls, printed, sleeps, advance: (ms: number) => (clock += ms) }
}

const LIVE = JSON.stringify({ accessToken: 'tok', refreshToken: 'r', expiresAt: 9_999_999_999 })
const OK_TOKEN: Reply = { status: 200, body: { access_token: 'new', refresh_token: 'nr', expires_in: 3600 } }
const PENDING: Reply = { status: 400, body: { error: 'authorization_pending' } }
const ME = (url: string): Reply | undefined =>
  url.includes('/me?$select') ? { status: 200, body: { mail: 'owner@company.com' } } : undefined

describe('ms-auth start', () => {
  it('shows the code and returns without waiting, so a chat turn is not held open', async () => {
    const w = world()
    const out = await runAuth(['start', '--account', 'work'], w.deps)
    expect(out).toContain('https://microsoft.com/devicelogin')
    expect(out).toContain('ABC-123')
    expect(out).toContain('ms-auth finish --account work')
    expect(w.sleeps).toHaveLength(0)
    expect(w.data.has('MS_PENDING_WORK')).toBe(true)
    expect(w.data.has('MS_TOKENS_WORK')).toBe(false)
  })

  it('falls back to the built-in app registration when none is configured', async () => {
    const w = world({ env: {} })
    let sent = ''
    const inner = w.deps.fetchImpl
    w.deps.fetchImpl = async (url, init) => ((sent = init?.body ?? ''), inner(url, init))
    await runAuth(['start'], w.deps)
    expect(sent).toContain('client_id=a67bec40-964d-4ea9-99bb-6a1301f217db')
  })
})

describe('ms-auth finish', () => {
  it('refuses when nothing was started', async () => {
    await expect(runAuth(['finish', '--account', 'work'], world().deps)).rejects.toThrow(/ms-auth start/)
  })

  it('polls at the interval Microsoft asked for, then stores the tokens and forgets the code', async () => {
    const w = world({ tokenReplies: [PENDING, PENDING, OK_TOKEN], graph: (u) => ME(u) ?? { status: 200, body: {} } })
    await runAuth(['start', '--account', 'work'], w.deps)
    const out = await runAuth(['finish', '--account', 'work'], w.deps)
    expect(out).toBe('Connected work as owner@company.com.')
    expect(w.sleeps).toEqual([5000, 5000])
    expect(JSON.parse(w.data.get('MS_TOKENS_WORK')!).refreshToken).toBe('nr')
    expect(w.data.has('MS_PENDING_WORK')).toBe(false)
  })

  it('with --wait 0 checks once and leaves the sign-in open', async () => {
    const w = world({ tokenReplies: [PENDING] })
    await runAuth(['start', '--account', 'work'], w.deps)
    const out = await runAuth(['finish', '--account', 'work', '--wait', '0'], w.deps)
    expect(out).toMatch(/still waiting/i)
    expect(out).toContain('ABC-123')
    expect(w.sleeps).toHaveLength(0)
    expect(w.data.has('MS_PENDING_WORK')).toBe(true)
  })

  it('widens the interval for good when told to slow down', async () => {
    const w = world({ tokenReplies: [{ status: 400, body: { error: 'slow_down' } }, OK_TOKEN] })
    await runAuth(['start', '--account', 'work'], w.deps)
    await runAuth(['finish', '--account', 'work'], w.deps)
    expect(w.sleeps).toEqual([10_000])
  })

  it('reports a declined sign-in and clears it so the next start is clean', async () => {
    const w = world({ tokenReplies: [{ status: 400, body: { error: 'authorization_declined', error_description: 'The user declined.' } }] })
    await runAuth(['start', '--account', 'work'], w.deps)
    await expect(runAuth(['finish', '--account', 'work'], w.deps)).rejects.toThrow(/declined/)
    expect(w.data.has('MS_PENDING_WORK')).toBe(false)
  })

  it('says the code expired instead of polling a dead one', async () => {
    const w = world()
    await runAuth(['start', '--account', 'work'], w.deps)
    w.advance(901_000)
    await expect(runAuth(['finish', '--account', 'work'], w.deps)).rejects.toThrow(/expired/)
    expect(w.data.has('MS_PENDING_WORK')).toBe(false)
  })

  it('keeps the sign-in even if naming the mailbox afterwards fails', async () => {
    const w = world({ tokenReplies: [OK_TOKEN], graph: () => ({ status: 500, body: {} }) })
    await runAuth(['start', '--account', 'work'], w.deps)
    expect(await runAuth(['finish', '--account', 'work'], w.deps)).toBe('Connected work.')
    expect(w.data.has('MS_TOKENS_WORK')).toBe(true)
  })
})

describe('ms-auth login', () => {
  it('prints the code first, then waits it out in one command', async () => {
    const w = world({ tokenReplies: [PENDING, OK_TOKEN], graph: (u) => ME(u) ?? { status: 200, body: {} } })
    const out = await runAuth(['login', '--account', 'work'], w.deps)
    expect(w.printed[0]).toContain('ABC-123')
    expect(out).toContain('Connected work')
  })
})

describe('ms-auth status and logout', () => {
  it('says plainly when nothing is connected', async () => {
    expect(await runAuth(['status'], world().deps)).toMatch(/no microsoft account/i)
  })

  it('names each connected mailbox', async () => {
    const w = world({ vault: { MS_TOKENS_WORK: LIVE }, graph: (u) => ME(u) ?? { status: 200, body: {} } })
    expect(await runAuth(['status'], w.deps)).toBe('WORK: connected as owner@company.com')
  })

  it('reports an account that is not connected rather than failing the whole command', async () => {
    const out = await runAuth(['status', '--account', 'ghost'], world().deps)
    expect(out).toMatch(/^ghost: Outlook is not connected/)
  })

  it('forgets the tokens, and says so when there were none', async () => {
    const w = world({ vault: { MS_TOKENS_WORK: LIVE } })
    expect(await runAuth(['logout', '--account', 'work'], w.deps)).toMatch(/removed/i)
    expect(w.data.has('MS_TOKENS_WORK')).toBe(false)
    expect(await runAuth(['logout', '--account', 'work'], w.deps)).toMatch(/no stored sign-in/i)
  })
})

describe('command parsing', () => {
  it('prints usage with no command, and refuses an unknown one', async () => {
    expect(await runAuth([], world().deps)).toBe(AUTH_USAGE)
    await expect(runAuth(['frobnicate'], world().deps)).rejects.toThrow(/unknown command/i)
  })

  it('refuses a flag it does not know, so a typo is not silently ignored', async () => {
    await expect(runMail(['send', 'D1', '--aproved'], world().deps)).rejects.toThrow(/aproved/)
  })

  it('falls back to MS_ACCOUNT, then to one unnamed mailbox', async () => {
    const w = world({ vault: { MS_TOKENS_SHARED: LIVE }, env: { MS_CLIENT_ID: 'cid', MS_ACCOUNT: 'shared' }, graph: () => ({ status: 200, body: { value: [] } }) })
    await runMail(['inbox'], w.deps)
    expect(w.graphCalls[0]!.auth).toBe('Bearer tok')
    await expect(runMail(['inbox'], world().deps)).rejects.toThrow(/"default"/)
  })
})

describe('ms-mail', () => {
  const MSG = {
    id: 'M1',
    subject: 'Invoice',
    from: { emailAddress: { name: 'Jane', address: 'jane@x.com' } },
    receivedDateTime: '2026-09-15T13:00:00Z',
    isRead: false,
    body: { content: 'Please pay.' },
  }
  const mailWorld = (graph?: (url: string, method: string, body: unknown) => Reply) =>
    world({ vault: { MS_TOKENS_WORK: LIVE }, graph: graph ?? (() => ({ status: 200, body: { value: [MSG] } })) })

  it('lists the inbox with times in the owner zone', async () => {
    const w = mailWorld()
    const out = await runMail(['inbox', '--account', 'work', '--count', '3'], w.deps)
    expect(w.graphCalls[0]!.url).toContain('$top=3')
    expect(out).toContain('2026-09-15 09:00')
    expect(out).toContain('id M1')
  })

  it('searches with every word of the query', async () => {
    const w = mailWorld()
    await runMail(['search', 'unpaid', 'invoice', '--account', 'work'], w.deps)
    expect(decodeURIComponent(w.graphCalls[0]!.url)).toContain('$search="unpaid invoice"')
  })

  it('refuses a search with no query', async () => {
    await expect(runMail(['search', '--account', 'work'], mailWorld().deps)).rejects.toThrow(/query/)
  })

  it('reads a message with its headers', async () => {
    const w = mailWorld(() => ({ status: 200, body: MSG }))
    const out = await runMail(['read', 'M1', '--account', 'work'], w.deps)
    expect(out).toContain('Subject: Invoice')
    expect(out).toContain('From: Jane <jane@x.com>')
    expect(out).toContain('Received: 2026-09-15 09:00')
    expect(out).toContain('Please pay.')
  })

  it('cuts a huge body instead of pouring it into the chat', async () => {
    const w = mailWorld(() => ({ status: 200, body: { ...MSG, body: { content: 'x'.repeat(25_000) } } }))
    const out = await runMail(['read', 'M1', '--account', 'work'], w.deps)
    expect(out).toContain('[cut: 5000 more characters]')
  })

  it('drafts, and says nothing was sent', async () => {
    const w = mailWorld(() => ({ status: 201, body: { id: 'D1' } }))
    const out = await runMail(
      ['draft', '--account', 'work', '--to', 'a@b.com, c@d.com', '--subject', 'Hi', '--body', 'Hello'],
      w.deps
    )
    expect(out).toBe('Draft saved (id D1). Nothing was sent.')
    expect((w.graphCalls[0]!.body as { toRecipients: unknown[] }).toRecipients).toHaveLength(2)
  })

  it('will not draft to nobody', async () => {
    await expect(runMail(['draft', '--account', 'work', '--subject', 'S', '--body', 'B'], mailWorld().deps)).rejects.toThrow(/--to/)
  })

  it('saves a reply as a draft', async () => {
    const w = mailWorld(() => ({ status: 201, body: { id: 'R1' } }))
    const out = await runMail(['reply', 'M1', '--account', 'work', '--body', 'On it.', '--all'], w.deps)
    expect(w.graphCalls[0]!.url).toContain('/me/messages/M1/createReplyAll')
    expect(out).toContain('Nothing was sent')
  })

  it('will not send without --approved, and makes no call trying', async () => {
    const w = mailWorld()
    await expect(runMail(['send', 'D1', '--account', 'work'], w.deps)).rejects.toThrow(/approv/i)
    expect(w.graphCalls).toHaveLength(0)
  })

  it('sends the draft once approved', async () => {
    const w = mailWorld(() => ({ status: 202, body: {} }))
    expect(await runMail(['send', 'D1', '--account', 'work', '--approved'], w.deps)).toBe('Sent.')
    expect(w.graphCalls[0]).toMatchObject({ method: 'POST' })
    expect(w.graphCalls[0]!.url).toContain('/me/messages/D1/send')
  })
})

describe('ms-calendar', () => {
  const EVT = {
    id: 'E1',
    subject: 'Standup',
    start: { dateTime: '2026-09-16T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-16T13:15:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
  }
  const calWorld = (graph?: (url: string, method: string, body: unknown) => Reply) =>
    world({ vault: { MS_TOKENS_WORK: LIVE }, graph: graph ?? (() => ({ status: 200, body: { value: [EVT] } })) })

  it("shows today's events in local time", async () => {
    const out = await runCalendar(['today', '--account', 'work'], calWorld().deps)
    expect(out).toBe('09:00-09:15  Standup')
  })

  it('dates the events when range covers more than one day, even if only one day has any', async () => {
    const out = await runCalendar(['range', '2026-09-14', '2026-09-20', '--account', 'work'], calWorld().deps)
    expect(out).toBe('Wed 2026-09-16\n  09:00-09:15  Standup')
  })

  it('reads a single day when range gets one date', async () => {
    const w = calWorld()
    await runCalendar(['range', '2026-09-16', '--account', 'work'], w.deps)
    const url = decodeURIComponent(w.graphCalls[0]!.url)
    expect(url).toContain('startDateTime=2026-09-16T00:00:00-04:00')
    expect(url).toContain('endDateTime=2026-09-17T00:00:00-04:00')
  })

  it('creates an event in the install timezone', async () => {
    const w = calWorld(() => ({ status: 201, body: { id: 'E9' } }))
    const out = await runCalendar(
      ['create', '--account', 'work', '--subject', 'Review', '--start', '2026-09-20T10:00', '--end', '2026-09-20T11:00'],
      w.deps
    )
    expect(out).toBe('Created "Review" on 2026-09-20 10:00-11:00 (America/Toronto). Id E9')
    expect((w.graphCalls[0]!.body as { start: { timeZone: string } }).start.timeZone).toBe('America/Toronto')
  })

  it('will not invite anyone without --approved', async () => {
    const w = calWorld()
    await expect(
      runCalendar(
        ['create', '--account', 'work', '--subject', 'R', '--start', '2026-09-20T10:00', '--end', '2026-09-20T11:00', '--attendees', 'x@y.com'],
        w.deps
      )
    ).rejects.toThrow(/approv/i)
    expect(w.graphCalls).toHaveLength(0)
  })

  it('says who was invited when it does invite', async () => {
    const w = calWorld(() => ({ status: 201, body: { id: 'E9' } }))
    const out = await runCalendar(
      ['create', '--account', 'work', '--subject', 'R', '--start', '2026-09-20T10:00', '--end', '2026-09-20T11:00', '--attendees', 'x@y.com', '--approved'],
      w.deps
    )
    expect(out).toContain('invitations sent to x@y.com')
  })
})
