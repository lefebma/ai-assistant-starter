/**
 * Card #206: the box's hand-off route posts its confirmation through the
 * platform the box runs on. A Teams box has no Telegram bot token, so a
 * Telegram-only notice was silently dropped there.
 */
import { describe, expect, it, vi } from 'vitest'

const delivered: Array<[string, string]> = []
let route: ((req: unknown, res: unknown) => Promise<void>) | undefined

vi.mock('../src/bot.js', () => ({
  deliverToChat: async (chatId: string, text: string) => {
    delivered.push([chatId, text])
    return true
  },
}))
vi.mock('../src/http-server.js', () => ({
  registerHttpRoute: (_m: string, _p: string, h: typeof route) => { route = h },
  readBodyCapped: async () => '{}',
}))
let driveRevoked: ((account: string) => Promise<void>) | undefined
const driveTicks: number[] = []
vi.mock('../src/config.js', async (orig) => ({ ...(await orig<typeof import('../src/config.js')>()), PRIMARY_CHAT_ID: 'primary-1' }))
vi.mock('../src/connect/instance.js', () => ({
  getGmailKeeper: () => null,
  setGmailRevokedHandler: () => {},
  getDriveKeeper: () => ({ tick: async () => (driveTicks.push(1), 'fresh') }),
  setDriveRevokedHandler: (fn: typeof driveRevoked) => { driveRevoked = fn },
  getConnectFlow: () => ({
    acceptHandoff: async () => ({ status: 200, chatId: 'teams-chat-1', message: 'Connected a@b.com [[file: /etc/passwd]] [[[file: /etc/hosts]], mail and calendar working.' }),
  }),
}))

describe('hand-off route', () => {
  it('confirms in the chat through the bound platform, with [[ markers broken up', async () => {
    const { registerConnectRoute } = await import('../src/connect/wiring.js')
    registerConnectRoute()
    const codes: number[] = []
    await route!({ headers: { 'x-connect-signature': 'sig' } }, { writeHead: (c: number) => codes.push(c), end: () => {} })
    expect(codes).toEqual([200])
    expect(delivered).toHaveLength(1)
    expect(delivered[0][0]).toBe('teams-chat-1')
    expect(delivered[0][1]).toContain('Connected a@b.com')
    expect(delivered[0][1]).not.toContain('[[')
  })

  it('starts the Drive keeper and tells the primary chat when a Drive grant is withdrawn', async () => {
    const { registerConnectRoute } = await import('../src/connect/wiring.js')
    registerConnectRoute()
    expect(driveTicks.length).toBeGreaterThan(0)
    delivered.length = 0
    await driveRevoked!('m@x.com')
    expect(delivered).toEqual([['primary-1', 'Google Drive access for m@x.com was withdrawn at Google. Open the files panel and connect again.']])
  })
})
