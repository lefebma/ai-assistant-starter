import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let s: typeof import('../src/web/sessions.js')
let db: typeof import('../src/db.js')

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-sessions-'))
  process.env['HTTP_BEARER_TOKEN'] = 'test-bearer'
  db = await import('../src/db.js')
  db.initDatabase()
  s = await import('../src/web/sessions.js')
})

describe('web links', () => {
  it('mints a link that exchanges exactly once', () => {
    const { token, expiresAt } = s.mintWebLink('c1', 1000)
    expect(expiresAt).toBe(1000 + s.LINK_TTL_MS)
    const first = s.exchangeWebLink(token, 'Chrome', 2000)
    expect(first?.chatId).toBe('c1')
    expect(s.exchangeWebLink(token, 'Chrome', 2001)).toBeNull()
  })
  it('rejects an expired or unknown link', () => {
    const { token } = s.mintWebLink('c2', 1000)
    expect(s.exchangeWebLink(token, '', 1000 + s.LINK_TTL_MS)).toBeNull()
    expect(s.exchangeWebLink('nope', '', 1000)).toBeNull()
    expect(s.exchangeWebLink('', '', 1000)).toBeNull()
  })
  it('a second mint invalidates the first unused link', () => {
    const a = s.mintWebLink('c3', 1000)
    const b = s.mintWebLink('c3', 1001)
    expect(s.exchangeWebLink(a.token, '', 1002)).toBeNull()
    expect(s.exchangeWebLink(b.token, '', 1002)?.chatId).toBe('c3')
  })
  it('stores no raw token or session id', () => {
    const { token } = s.mintWebLink('c4', 1000)
    const ex = s.exchangeWebLink(token, 'x', 1001)!
    const d = db.getDb()
    const dump = JSON.stringify([
      d.prepare('SELECT * FROM web_link_tokens').all(),
      d.prepare('SELECT * FROM web_sessions').all(),
    ])
    expect(dump).not.toContain(token)
    expect(dump).not.toContain(ex.sessionId)
  })
})

describe('web sessions', () => {
  it('resolves, slides expiry only after an hour idle, and expires', () => {
    const { token } = s.mintWebLink('c5', 0)
    const { sessionId } = s.exchangeWebLink(token, '', 0)!
    expect(s.resolveWebSession(sessionId, 1000)?.chatId).toBe('c5')
    const exp = () =>
      (db.getDb().prepare('SELECT expires_at FROM web_sessions WHERE chat_id = ?').get('c5') as { expires_at: number }).expires_at
    expect(exp()).toBe(s.SESSION_TTL_MS)
    s.resolveWebSession(sessionId, 3_600_001)
    expect(exp()).toBe(3_600_001 + s.SESSION_TTL_MS)
    expect(s.resolveWebSession(sessionId, 3_600_001 + s.SESSION_TTL_MS)).toBeNull()
    expect(s.resolveWebSession('', 1)).toBeNull()
  })
  it('revocation is scoped to the chat', () => {
    const mk = (chat: string) => {
      const { token } = s.mintWebLink(chat, 10)
      return s.exchangeWebLink(token, chat, 10)!.sessionId
    }
    const a = mk('A')
    const b = mk('B')
    const b2 = mk('B')
    const bHash = s.resolveWebSession(b, 11)!.idHash
    expect(s.revokeWebSession('A', bHash)).toBe(false)
    expect(s.resolveWebSession(b, 12)).not.toBeNull()
    const b2Hash = s.resolveWebSession(b2, 12)!.idHash
    expect(s.revokeOtherWebSessions('B', b2Hash)).toBe(1)
    expect(s.listWebSessions('B')).toHaveLength(1)
    expect(s.revokeWebSession('B', b2Hash)).toBe(true)
    expect(s.revokeAllWebSessions('A')).toBe(1)
    expect(s.resolveWebSession(a, 13)).toBeNull()
  })
})

describe('cookies and urls', () => {
  it('builds exact cookie strings', () => {
    expect(s.webSessionCookie('abc', true, 5000)).toBe('havn_web=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=5; Secure')
    expect(s.webSessionCookie('abc', false, 5000)).toBe('havn_web=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=5')
    expect(s.clearWebCookie(false)).toBe('havn_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
  })
  it('reads the session from a Cookie header', () => {
    expect(s.webSessionFromCookies('a=1; havn_web=xyz; b=2')).toBe('xyz')
    expect(s.webSessionFromCookies('a=1')).toBeNull()
    expect(s.webSessionFromCookies(undefined)).toBeNull()
  })
  it('builds the app url', () => {
    expect(s.webAppUrl('T', 'box.example.com', 3000)).toBe('https://box.example.com/app#token=T')
    expect(s.webAppUrl('T', '', 3000, '192.168.1.5')).toBe('http://192.168.1.5:3000/app#token=T')
    expect(s.webAppUrl('T', '', 3000, null)).toBeNull()
  })
})
