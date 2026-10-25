import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PRIMARY_CHAT_ID comes from .env, which a test checkout does not have.
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
}))

let port = 0
let sessions: typeof import('../src/web/sessions.js')
let db: typeof import('../src/db.js')
let web: typeof import('../src/web/http.js')
let server: typeof import('../src/http-server.js')

const PRIMARY = '4242'
const BEARER = 'test-bearer'

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-http-'))
  process.env['HTTP_BEARER_TOKEN'] = BEARER
  db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  web = await import('../src/web/http.js')
  server = await import('../src/http-server.js')
  // Band 5450-5489: each HTTP test file draws from its own slice of 5400-5600.
  port = 5450 + Math.floor(Math.random() * 40)
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
})

afterAll(async () => {
  await server.stopHttpServer()
})

const base = () => `http://127.0.0.1:${port}`

/** A session cookie for a chat, minted the real way: link then exchange. */
function sessionFor(chatId: string): string {
  const { token } = sessions.mintWebLink(chatId)
  const made = sessions.exchangeWebLink(token, 'test')!
  return `havn_web=${made.sessionId}`
}

/** Raw request so the path reaches the server un-normalised. */
function raw(
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('web auth boundary', () => {
  it('gives 401 with no credentials', async () => {
    const r = await fetch(`${base()}/api/web/me`)
    expect(r.status).toBe(401)
  })
  it('gives 401 to the box bearer token alone', async () => {
    const r = await fetch(`${base()}/api/web/me`, { headers: { Authorization: `Bearer ${BEARER}` } })
    expect(r.status).toBe(401)
  })
  it('gives 401 to a voice cookie alone', async () => {
    const r = await fetch(`${base()}/api/web/me`, { headers: { Cookie: 'havn_voice=abc; voice_session=abc' } })
    expect(r.status).toBe(401)
  })
  it('gives 401 to an unknown web cookie', async () => {
    const r = await fetch(`${base()}/api/web/me`, { headers: { Cookie: 'havn_web=nope' } })
    expect(r.status).toBe(401)
  })
  it('gives 200 to a valid session and reports the chat', async () => {
    const r = await fetch(`${base()}/api/web/me`, { headers: { Cookie: sessionFor(PRIMARY) } })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { chatId: string; isPrimary: boolean; assistantName: string }
    expect(j.chatId).toBe(PRIMARY)
    expect(j.isPrimary).toBe(true)
    expect(typeof j.assistantName).toBe('string')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
  it('gives 401 once the chat is no longer authorized', async () => {
    db.addAuthorizedChat('777', 'x', PRIMARY)
    const cookie = sessionFor('777')
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: cookie } })).status).toBe(200)
    db.removeAuthorizedChat('777')
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: cookie } })).status).toBe(401)
  })
  it('deletes every web session of a chat that is no longer allowed, so re-allowing it revives none', async () => {
    db.addAuthorizedChat('778', 'x', PRIMARY)
    const a = sessionFor('778')
    sessionFor('778')
    expect(sessions.listWebSessions('778')).toHaveLength(2)
    db.removeAuthorizedChat('778')
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: a } })).status).toBe(401)
    expect(sessions.listWebSessions('778')).toHaveLength(0)
    db.addAuthorizedChat('778', 'x', PRIMARY)
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: a } })).status).toBe(401)
  })
  it('re-sends the cookie with a fresh Max-Age when the session slides', async () => {
    const cookie = sessionFor(PRIMARY)
    const id = cookie.slice('havn_web='.length)
    const fresh = await fetch(`${base()}/api/web/me`, { headers: { Cookie: cookie } })
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('set-cookie')).toBeNull()
    // Two hours idle: the next request slides the session and the browser must hear about it.
    const { createHash } = await import('node:crypto')
    const idHash = createHash('sha256').update(id, 'utf8').digest('hex')
    db.getDb().prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?').run(Date.now() - 2 * 3600_000, idHash)
    const slid = await fetch(`${base()}/api/web/me`, { headers: { Cookie: cookie } })
    expect(slid.status).toBe(200)
    const c = slid.headers.get('set-cookie')!
    expect(c).toContain(`havn_web=${id}`)
    expect(c).toContain('Max-Age=2592000')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/')
  })
  it('gives 404 for an unknown api path and 405 for a wrong method', async () => {
    const cookie = sessionFor(PRIMARY)
    expect((await fetch(`${base()}/api/web/nope`, { headers: { Cookie: cookie } })).status).toBe(404)
    expect((await fetch(`${base()}/api/web/me`, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(405)
  })
})

describe('browser hardening', () => {
  it('rejects a non-JSON POST with 415', async () => {
    const r = await fetch(`${base()}/api/web/signout`, {
      method: 'POST',
      headers: { Cookie: sessionFor(PRIMARY), 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(r.status).toBe(415)
  })
  it('rejects a foreign Origin with 403, even with a valid session', async () => {
    const r = await fetch(`${base()}/api/web/me`, {
      headers: { Cookie: sessionFor(PRIMARY), Origin: 'https://evil.example' },
    })
    expect(r.status).toBe(403)
  })
  it('accepts a same-host Origin', async () => {
    const r = await fetch(`${base()}/api/web/me`, {
      headers: { Cookie: sessionFor(PRIMARY), Origin: `http://127.0.0.1:${port}` },
    })
    expect(r.status).toBe(200)
  })
  it('sends no CORS headers on a preflight from a localhost origin', async () => {
    const r = await fetch(`${base()}/api/web/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'GET' },
    })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
    expect(r.headers.get('access-control-allow-credentials')).toBeNull()
    expect(r.status).not.toBe(204)
  })
  it('sends no CORS headers on a normal api response either', async () => {
    const r = await fetch(`${base()}/api/web/me`, { headers: { Origin: `http://127.0.0.1:${port}` } })
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('serves /app with the exact CSP and companion headers', async () => {
    for (const p of ['/app', '/app/']) {
      const r = await fetch(`${base()}${p}`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/html')
      expect(r.headers.get('content-security-policy')).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      )
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('referrer-policy')).toBe('no-referrer')
      expect(r.headers.get('x-frame-options')).toBe('DENY')
    }
  })
  it('gives a non-canonical path to the page the same headers', async () => {
    for (const p of ['/./app/index.html', '/x/%2e%2e/app/index.html']) {
      const r = await raw(p)
      expect(r.status, p).toBe(200)
      expect(r.headers['content-security-policy'], p).toContain("default-src 'none'")
      expect(r.headers['x-frame-options'], p).toBe('DENY')
      expect(r.headers['x-content-type-options'], p).toBe('nosniff')
    }
    // Upper case never reaches the general static router (a macOS disk would
    // match it to public/app/index.html without these headers).
    const upper = await raw('/APP/index.html')
    expect(upper.headers['content-security-policy']).toContain("default-src 'none'")
    expect(upper.headers['x-frame-options']).toBe('DENY')
    const api = await raw('/./api/web/me', { Authorization: `Bearer ${BEARER}` })
    expect(api.status).toBe(401)
    expect(api.headers['content-security-policy']).toContain("default-src 'none'")
  })
  it('puts the same headers on api errors', async () => {
    const r = await fetch(`${base()}/api/web/me`)
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
})

describe('page serving', () => {
  it('404s traversal attempts, encoded or not', async () => {
    for (const p of [
      '/app/../package.json',
      '/app/%2e%2e/package.json',
      '/app/%2E%2E/package.json',
      '/app/..%2fpackage.json',
      '/app/%2e%2e%2f%2e%2e%2fpackage.json',
      '/app/..%5cpackage.json',
      '/app//etc/passwd',
      '/app/.env',
      '/app/index.html%00.js',
    ]) {
      const r = await raw(p)
      expect(r.status, p).toBe(404)
      expect(r.body, p).not.toContain('"name"')
    }
  })
  it('serves the page scripts, styles and icon with the right MIME types', async () => {
    for (const [p, type] of [
      ['/app/app.js', 'text/javascript'],
      ['/app/api.js', 'text/javascript'],
      ['/app/markdown.js', 'text/javascript'],
      ['/app/app.css', 'text/css'],
      ['/app/icon.svg', 'image/svg+xml'],
    ]) {
      const r = await fetch(`${base()}${p}`)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('content-type'), p).toContain(type)
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff')
    }
  })
  it('404s a disallowed extension and a missing file', async () => {
    expect((await raw('/app/index.ts')).status).toBe(404)
    expect((await raw('/app/missing.js')).status).toBe(404)
  })
  it('refuses a non-GET on a page', async () => {
    const r = await fetch(`${base()}/app`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(405)
  })
})

describe('session routes', () => {
  const post = (path: string, cookie: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify(body),
    })

  it('exchanges a link for an HttpOnly SameSite=Strict cookie, once', async () => {
    const { token } = sessions.mintWebLink(PRIMARY)
    const r = await post('/api/web/session', undefined, { token }, { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' })
    expect(r.status).toBe(200)
    const c = r.headers.get('set-cookie')!
    expect(c).toContain('havn_web=')
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).not.toContain('Secure')
    const again = await post('/api/web/session', undefined, { token })
    expect(again.status).toBe(401)
    expect(await again.json()).toEqual({ error: 'invalid_link' })
    const cookie = c.split(';')[0]
    const list = (await (await fetch(`${base()}/api/web/sessions`, { headers: { Cookie: cookie } })).json()) as {
      sessions: { label: string; current: boolean }[]
    }
    expect(list.sessions.find((s) => s.current)?.label).toBe('Safari on macOS')
  })
  it('adds Secure when the edge says https', async () => {
    const { token } = sessions.mintWebLink(PRIMARY)
    const r = await post('/api/web/session', undefined, { token }, { 'X-Forwarded-Proto': 'https' })
    expect(r.headers.get('set-cookie')).toContain('Secure')
  })
  it('rejects a bad token and a non-JSON exchange', async () => {
    expect((await post('/api/web/session', undefined, { token: 'nope' })).status).toBe(401)
    expect((await post('/api/web/session', undefined, {})).status).toBe(401)
    const r = await fetch(`${base()}/api/web/session`, { method: 'POST', body: 'token=x' })
    expect(r.status).toBe(415)
  })
  it('rejects an oversized body with 413', async () => {
    const r = await post('/api/web/session', undefined, { token: 'x'.repeat(300_000) })
    expect(r.status).toBe(413)
  })
  it('signs out: revokes the session and clears the cookie', async () => {
    const cookie = sessionFor(PRIMARY)
    const r = await post('/api/web/signout', cookie, {})
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: cookie } })).status).toBe(401)
  })
  it('revokes other sessions but keeps the current one', async () => {
    const chat = '9001'
    db.addAuthorizedChat(chat, 'x', PRIMARY)
    const mine = sessionFor(chat)
    const other = sessionFor(chat)
    const r = await post('/api/web/sessions/revoke', mine, { others: true })
    expect(((await r.json()) as { revoked: number }).revoked).toBe(1)
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: mine } })).status).toBe(200)
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: other } })).status).toBe(401)
  })
  it('cannot revoke another chat\'s session by hash', async () => {
    db.addAuthorizedChat('9002', 'x', PRIMARY)
    const victim = sessionFor(PRIMARY)
    const list = (await (await fetch(`${base()}/api/web/sessions`, { headers: { Cookie: victim } })).json()) as {
      sessions: { idHash: string; current: boolean }[]
    }
    const hash = list.sessions.find((s) => s.current)!.idHash
    const attacker = sessionFor('9002')
    const r = await post('/api/web/sessions/revoke', attacker, { idHash: hash })
    expect(((await r.json()) as { revoked: number }).revoked).toBe(0)
    expect((await fetch(`${base()}/api/web/me`, { headers: { Cookie: victim } })).status).toBe(200)
  })
})

describe('rate limit', () => {
  it('allows 10 attempts per address then refuses', () => {
    web.resetAttempts()
    const now = 1_000_000
    for (let i = 0; i < 10; i++) expect(web.allowAttempt('1.2.3.4', now + i)).toBe(true)
    expect(web.allowAttempt('1.2.3.4', now + 11)).toBe(false)
    expect(web.allowAttempt('5.6.7.8', now + 11)).toBe(true)
    expect(web.allowAttempt('1.2.3.4', now + 10 * 60_000 + 1)).toBe(true)
  })
  it('answers the 11th exchange over HTTP with 429', async () => {
    web.resetAttempts()
    let last = 0
    for (let i = 0; i < 11; i++) {
      const r = await fetch(`${base()}/api/web/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      })
      last = r.status
      if (i < 10) expect(r.status).toBe(401)
    }
    expect(last).toBe(429)
    web.resetAttempts()
  })
})

describe('label', () => {
  it('reduces a user agent to a short phrase', () => {
    expect(web.sessionLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS')
    expect(web.sessionLabel(undefined)).toBe('Browser')
    expect(web.sessionLabel('x'.repeat(500)).length).toBeLessThanOrEqual(60)
  })
})

describe('registerWebRoutes and sse', () => {
  it('lets a later task register an authenticated sse route with params', async () => {
    const { openSse } = await import('../src/web/respond.js')
    const off = web.registerWebRoutes([
      {
        method: 'GET',
        pattern: /^\/api\/web\/_probe\/([^/]+)\/stream$/,
        auth: true,
        handler(ctx) {
          const sse = openSse(ctx.res, { heartbeatMs: 0 })
          sse.writeEvent('hello', { id: ctx.params[0], chat: ctx.chatId })
          sse.close()
        },
      },
    ])
    expect((await fetch(`${base()}/api/web/_probe/a%20b/stream`)).status).toBe(401)
    const r = await fetch(`${base()}/api/web/_probe/a%20b/stream`, { headers: { Cookie: sessionFor(PRIMARY) } })
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.text()).toBe(`event: hello\ndata: ${JSON.stringify({ id: 'a b', chat: PRIMARY })}\n\n`)
    off()
    expect((await fetch(`${base()}/api/web/_probe/x/stream`, { headers: { Cookie: sessionFor(PRIMARY) } })).status).toBe(404)
  })
})
