import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
}))

const update = vi.hoisted(() => ({
  status: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, checkedAt: 1 } as any,
  throws: false,
  pending: false,
}))
vi.mock('../src/updater.js', () => ({
  checkForUpdate: vi.fn(async () => {
    if (update.throws) throw new Error('offline')
    return update.status
  }),
  restartPending: () => update.pending,
  getCurrentVersion: () => '1.0.0',
}))

let port = 0
let server: typeof import('../src/http-server.js')
let cookie = ''

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-status-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  const sessions = await import('../src/web/sessions.js')
  server = await import('../src/http-server.js')
  // The route runs injected sources: no gog lookup, no `claude auth status`.
  const connections = await import('../src/web/connections.js')
  connections.setConnectionDepsForTest({
    model: async () => ({ ok: true, detail: 'fake model ok' }),
    telegramConfigured: () => true,
    gmailAccounts: async () => [],
    outlookAccounts: () => [],
    imapAccounts: () => [],
    voice: () => ({ stt: false, tts: false }),
    shortcut: (chatId) => (chatId === '4242' ? { createdAt: 1, lastUsedAt: null } : null),
    managedAi: () => false,
    aiUsage: () => null,
    brokenMailboxes: async () => [],
    chatId: () => 'not-the-session-chat',
  })
  // Band 5560-5574.
  port = 5560 + Math.floor(Math.random() * 15)
  server.startHttpServer(port)
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready__`)
      break
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  const { token } = sessions.mintWebLink('4242')
  cookie = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
})
afterAll(async () => {
  ;(await import('../src/web/connections.js')).setConnectionDepsForTest(null)
  await server.stopHttpServer()
})

const base = () => `http://127.0.0.1:${port}`
const H = () => ({ Cookie: cookie, 'Content-Type': 'application/json' })
const status = async () => (await fetch(`${base()}/api/web/status`, { headers: H() })).json() as Promise<any>
const dismiss = (version: string) =>
  fetch(`${base()}/api/web/status/dismiss`, { method: 'POST', headers: H(), body: JSON.stringify({ version }) })

describe('web status', () => {
  it('reports an available update, not dismissed', async () => {
    expect(await status()).toEqual({
      version: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      restartPending: false,
      dismissed: false,
    })
  })

  it('dismisses only the same version; a newer one shows again', async () => {
    expect((await dismiss('1.1.0')).status).toBe(200)
    expect((await status()).dismissed).toBe(true)
    update.status = { ...update.status, latestVersion: '1.2.0' }
    expect((await status()).dismissed).toBe(false)
  })

  it('rejects an empty version', async () => {
    expect((await dismiss('')).status).toBe(400)
  })

  it('reports restart pending', async () => {
    update.pending = true
    expect((await status()).restartPending).toBe(true)
    update.pending = false
  })

  it('on error says no update', async () => {
    update.throws = true
    const s = await status()
    expect(s.updateAvailable).toBe(false)
    expect(s.dismissed).toBe(false)
    update.throws = false
  })

  it('requires sign-in', async () => {
    expect((await fetch(`${base()}/api/web/status`)).status).toBe(401)
    expect((await fetch(`${base()}/api/web/connections`)).status).toBe(401)
  })

  it('connections route returns a list without secrets', async () => {
    const r = await fetch(`${base()}/api/web/connections`, { headers: H() })
    expect(r.status).toBe(200)
    const l = (await r.json()) as any[]
    expect(l.map((c) => c.id)).toContain('telegram')
    expect(l.find((c) => c.id === 'model').detail).toBe('fake model ok')
    // The signed-in chat, not the injected default, decides the shortcut entry.
    expect(l.find((c) => c.id === 'shortcut').status).toBe('connected')
    expect(JSON.stringify(l)).not.toContain('\u2014')
    const now = await fetch(`${base()}/api/web/connections/check`, { method: 'POST', headers: H(), body: '{}' })
    expect(now.status).toBe(200)
    expect(((await now.json()) as any[]).find((c) => c.id === 'model').detail).toBe('fake model ok')
  })
})
