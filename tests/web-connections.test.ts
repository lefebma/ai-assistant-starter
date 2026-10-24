import { describe, it, expect } from 'vitest'
import { getConnections, checkConnectionsNow, type ConnectionDeps } from '../src/web/connections.js'

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
    expect(JSON.stringify(l)).not.toContain('—')
    const off = await getConnections(deps({ gmailAccounts: async () => [], telegramConfigured: () => false, model: async () => ({ ok: false, detail: 'no key' }) }))
    expect(JSON.stringify(off)).not.toContain('—')
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
