import { describe, it, expect } from 'vitest'
import { getConnections, checkConnectionsNow, cachedCheck, type ConnectionDeps } from '../src/web/connections.js'
import { checkClaudeAuthAsync, spawnClaudeAsync } from '../src/infra/claude-auth.js'
import { parseGmailAccounts } from '../src/email-alerts/sources.js'

function deps(over: Partial<ConnectionDeps> = {}): ConnectionDeps {
  return {
    model: async () => ({ ok: true, detail: 'signed in' }),
    telegramConfigured: () => true,
    gmailAccounts: async () => ['a@gmail.com'],
    outlookAccounts: () => [],
    imapAccounts: () => [],
    voice: () => ({ stt: false, tts: false }),
    shortcut: () => null,
    managedAi: () => false,
    aiUsage: () => null,
    brokenMailboxes: async () => [],
    chatId: () => '1',
    ...over,
  }
}
const by = (l: Awaited<ReturnType<typeof getConnections>>, id: string) => l.find((c) => c.id === id)!

describe('getConnections', () => {
  it('reports connected and off, with a real next step only where one exists', async () => {
    const l = await getConnections(deps())
    expect(by(l, 'gmail').status).toBe('connected')
    expect(by(l, 'gmail').detail).toBe('a@gmail.com')
    expect(by(l, 'outlook').status).toBe('off')
    expect(by(l, 'outlook').next).toBe('Ask your provider to set this up.')
    expect(by(l, 'shortcut').next).toBe('Send /shortcut to your assistant to set this up.')
    expect(by(l, 'model').next).toBeUndefined()
    expect(l.find((c) => c.id === 'managed-ai')).toBeUndefined()
  })

  it('a throwing source gives attention and never throws', async () => {
    const l = await getConnections(
      deps({
        outlookAccounts: () => {
          throw new Error('vault locked secret-xyz')
        },
        gmailAccounts: async () => {
          throw new Error('boom')
        },
        model: async () => {
          throw new Error('x')
        },
      }),
    )
    for (const id of ['outlook', 'gmail', 'model']) {
      expect(by(l, id)).toMatchObject({ status: 'attention', detail: 'Could not check' })
    }
    expect(JSON.stringify(l)).not.toContain('secret-xyz')
  })

  it('gog missing means Gmail is off', async () => {
    const l = await getConnections(deps({ gmailAccounts: async () => null }))
    expect(by(l, 'gmail').status).toBe('off')
  })

  it('shows managed AI usage and flags 80%', async () => {
    const ok = await getConnections(deps({ managedAi: () => true, aiUsage: () => ({ usd: 1, capUsd: 10 }) }))
    expect(by(ok, 'managed-ai')).toMatchObject({ status: 'connected', detail: '$1.00 of $10.00 used this month' })
    const hot = await getConnections(deps({ managedAi: () => true, aiUsage: () => ({ usd: 8.5, capUsd: 10 }) }))
    expect(by(hot, 'managed-ai').status).toBe('attention')
  })

  it('copy has no em dash', async () => {
    const l = await getConnections(deps({ outlookAccounts: () => ['x@y.com'] }))
    expect(JSON.stringify(l)).not.toContain('\u2014')
    const off = await getConnections(deps({ gmailAccounts: async () => [], telegramConfigured: () => false, model: async () => ({ ok: false, detail: 'no key' }) }))
    expect(JSON.stringify(off)).not.toContain('\u2014')
  })
})

describe('checkConnectionsNow', () => {
  it('marks a broken mailbox as attention', async () => {
    const l = await checkConnectionsNow(
      deps({ brokenMailboxes: async () => [{ id: 'a@gmail.com', why: 'Gmail needs reconnecting for a@gmail.com.' }] }),
    )
    expect(by(l, 'gmail')).toMatchObject({ status: 'attention', detail: 'Gmail needs reconnecting for a@gmail.com.' })
  })

  it('marks a provider-level broken entry', async () => {
    const l = await checkConnectionsNow(
      deps({ outlookAccounts: () => ['o@x.com'], brokenMailboxes: async () => [{ id: 'outlook', why: 'Outlook needs reconnecting.' }] }),
    )
    expect(by(l, 'outlook').status).toBe('attention')
    expect(by(l, 'gmail').status).toBe('connected')
  })

  it('a failing probe does not throw', async () => {
    const l = await checkConnectionsNow(
      deps({
        brokenMailboxes: async () => {
          throw new Error('net')
        },
      }),
    )
    expect(by(l, 'gmail')).toMatchObject({ status: 'attention', detail: 'Could not check' })
  })
})

describe('cachedCheck (no child process on every Settings open)', () => {
  it('runs once for concurrent callers, caches for 5 minutes, then runs again', async () => {
    let calls = 0
    let release!: (v: string) => void
    let clock = 1_000_000
    const c = cachedCheck(
      () => {
        calls++
        return new Promise<string>((r) => (release = r))
      },
      5 * 60_000,
      () => clock,
    )
    const a = c.get()
    const b = c.get()
    expect(calls).toBe(1)
    release('first')
    expect(await a).toBe('first')
    expect(await b).toBe('first')
    clock += 4 * 60_000
    expect(await c.get()).toBe('first')
    expect(calls).toBe(1)
    clock += 2 * 60_000
    const d = c.get()
    expect(calls).toBe(2)
    release('second')
    expect(await d).toBe('second')
  })

  it('does not cache a failure, and reset forces a fresh run', async () => {
    let calls = 0
    const c = cachedCheck(async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return calls
    }, 60_000)
    await expect(c.get()).rejects.toThrow('flaky')
    expect(await c.get()).toBe(2)
    expect(await c.get()).toBe(2)
    c.reset()
    expect(await c.get()).toBe(3)
  })
})

describe('async claude auth check', () => {
  it('reads the status through an injected async runner', async () => {
    const seen: string[][] = []
    const r = await checkClaudeAuthAsync('/fake/claude', async (_bin, args) => {
      seen.push(args)
      return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
    })
    expect(seen).toEqual([['auth', 'status', '--json']])
    expect(r).toEqual({ loggedIn: true, detail: 'signed in with a Claude account' })
    expect(await checkClaudeAuthAsync(null, async () => 'x')).toEqual({
      loggedIn: false,
      detail: 'Claude engine not found in this install',
    })
    expect((await checkClaudeAuthAsync('/fake/claude', async () => null)).loggedIn).toBe(false)
  })

  it('a binary that cannot run resolves null instead of throwing', async () => {
    expect(await spawnClaudeAsync('/nonexistent/claude-binary-for-test', ['auth', 'status', '--json'])).toBeNull()
  })
})

describe('gmail account parsing is shared with email alerts', () => {
  it('parses gog auth list output', () => {
    expect(parseGmailAccounts('a@x.com\tdefault\tgmail,calendar\nb@y.com\tdefault\tcalendar\n')).toEqual(['a@x.com'])
  })
})
