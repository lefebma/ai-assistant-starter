import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both of these are read at import time, so they have to be set before anything
// pulls in config.js or db.js. Without a bearer token the server runs in its
// unauthenticated loopback mode and every assertion here passes vacuously.
const STORE = mkdtempSync(join(tmpdir(), 'havn-voice-session-'))
process.env['AGENT_STORE_DIR'] = STORE
process.env['HTTP_BEARER_TOKEN'] = 'operator-token-for-tests'

let mintVoiceLink: typeof import('../src/voice-links.js').mintVoiceLink
let revokeVoiceLinks: typeof import('../src/voice-links.js').revokeVoiceLinks
let exchangeVoiceToken: typeof import('../src/voice-links.js').exchangeVoiceToken
let resolveVoiceToken: typeof import('../src/voice-links.js').resolveVoiceToken
let resolveVoiceSession: typeof import('../src/voice-sessions.js').resolveVoiceSession
let revokeVoiceSessions: typeof import('../src/voice-sessions.js').revokeVoiceSessions
let VOICE_COOKIE: typeof import('../src/voice-sessions.js').VOICE_COOKIE
let VOICE_LINK_GRACE_MINUTES: number

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  const links = await import('../src/voice-links.js')
  mintVoiceLink = links.mintVoiceLink
  revokeVoiceLinks = links.revokeVoiceLinks
  exchangeVoiceToken = links.exchangeVoiceToken
  resolveVoiceToken = links.resolveVoiceToken
  const sessions = await import('../src/voice-sessions.js')
  resolveVoiceSession = sessions.resolveVoiceSession
  revokeVoiceSessions = sessions.revokeVoiceSessions
  VOICE_COOKIE = sessions.VOICE_COOKIE
  VOICE_LINK_GRACE_MINUTES = (await import('../src/config.js')).VOICE_LINK_GRACE_MINUTES
})

afterAll(async () => {
  try {
    const { getDb } = await import('../src/db.js')
    getDb().close()
  } catch {
    // no handle to close
  }
  try {
    rmSync(STORE, { recursive: true, force: true })
  } catch {
    // a temp dir that outlives the run is not worth failing over
  }
})

describe('exchanging a link for a session', () => {
  it('hands back a session for the chat that minted the link', () => {
    const link = mintVoiceLink('chat-exchange')
    const session = exchangeVoiceToken(link.token)
    expect(session).not.toBeNull()
    expect(session!.chatId).toBe('chat-exchange')
    expect(resolveVoiceSession(session!.id)).toBe('chat-exchange')
  })

  it('spends the link once its grace window closes', () => {
    // 1.23.0 killed the link on first use, which broke opening it on a laptop
    // and then a phone. First use now starts a short clock instead; the
    // window itself is covered in tests/voice-link-grace.test.ts. What this
    // test holds onto is the end state: the credential sitting in browser
    // history, in a referrer, or in someone's access log is worth nothing.
    const now = Date.now()
    const link = mintVoiceLink('chat-single-use', now)
    expect(resolveVoiceToken(link.token, now)).toBe('chat-single-use')

    expect(exchangeVoiceToken(link.token, now)).not.toBeNull()

    const afterWindow = now + (VOICE_LINK_GRACE_MINUTES + 1) * 60 * 1000
    expect(resolveVoiceToken(link.token, afterWindow)).toBeNull()
    expect(exchangeVoiceToken(link.token, afterWindow)).toBeNull()
  })

  it('refuses an unknown token', () => {
    expect(exchangeVoiceToken('not-a-token-anyone-minted')).toBeNull()
  })

  it('refuses an expired token without minting a session', () => {
    const link = mintVoiceLink('chat-expired-link')
    const afterExpiry = link.expiresAt + 1
    expect(exchangeVoiceToken(link.token, afterExpiry)).toBeNull()
  })

  it('gives the session the link\'s expiry rather than a fresh clock', () => {
    // "Expires in 12h" is what the chat message promised. Restarting the clock
    // on first load would quietly make that a lie, and would let a link held
    // for eleven hours buy another twelve.
    const link = mintVoiceLink('chat-inherits')
    const session = exchangeVoiceToken(link.token)
    expect(session!.expiresAt).toBe(link.expiresAt)
    expect(resolveVoiceSession(session!.id, link.expiresAt + 1)).toBeNull()
  })
})

describe('revocation reaches the session, not just the link', () => {
  it('kills a live session when the chat revokes', () => {
    const link = mintVoiceLink('chat-revoke')
    const session = exchangeVoiceToken(link.token)!
    expect(resolveVoiceSession(session.id)).toBe('chat-revoke')

    revokeVoiceLinks('chat-revoke')
    expect(resolveVoiceSession(session.id)).toBeNull()
  })

  it('kills a live session when the chat mints a replacement link', () => {
    const first = mintVoiceLink('chat-remint')
    const session = exchangeVoiceToken(first.token)!
    expect(resolveVoiceSession(session.id)).toBe('chat-remint')

    mintVoiceLink('chat-remint')
    expect(resolveVoiceSession(session.id)).toBeNull()
  })

  it('leaves other chats alone', () => {
    const mine = exchangeVoiceToken(mintVoiceLink('chat-keep').token)!
    const theirs = exchangeVoiceToken(mintVoiceLink('chat-drop').token)!
    revokeVoiceSessions('chat-drop')
    expect(resolveVoiceSession(mine.id)).toBe('chat-keep')
    expect(resolveVoiceSession(theirs.id)).toBeNull()
  })
})

describe('the session cookie, over HTTP', () => {
  // 5700-5890: clear of the 5100 and 5400 bands the other HTTP suites draw
  // from, and clear of fetch's blocked-port list (4045, 4190, 6000, 6665-6669).
  let nextPort = 5700 + Math.floor(Math.random() * 20) * 10

  async function startServer(): Promise<number> {
    const { startHttpServer } = await import('../src/http-server.js')
    const port = nextPort++
    startHttpServer(port)
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${port}/__ready__`)
        return port
      } catch (err) {
        if (Date.now() > deadline) throw err
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }

  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const { stopHttpServer } = await import('../src/http-server.js')
    const port = await startServer()
    try {
      await fn(port)
    } finally {
      await stopHttpServer()
    }
  }

  function exchange(port: number, token: string, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${port}/api/voice-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ token }),
    })
  }

  /** The Set-Cookie line for our cookie, or '' if the response set none. */
  function cookieLine(resp: Response): string {
    return resp.headers.getSetCookie().find((c) => c.startsWith(`${VOICE_COOKIE}=`)) ?? ''
  }

  /** What a browser would send back on the next request. */
  function cookieHeader(resp: Response): string {
    return cookieLine(resp).split(';')[0] ?? ''
  }

  it('sets an HttpOnly, SameSite cookie the page cannot read', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-http-flags')
      const resp = await exchange(port, link.token)
      expect(resp.status).toBe(200)

      const line = cookieLine(resp)
      expect(line).not.toBe('')
      // HttpOnly is what stops an XSS on the page from walking off with the
      // session, which the old token in a JS variable could not claim.
      expect(line).toMatch(/;\s*HttpOnly/i)
      expect(line).toMatch(/;\s*SameSite=Lax/i)
      expect(line).toMatch(/;\s*Path=\//i)
      expect(line).toMatch(/;\s*Max-Age=\d+/i)
    })
  })

  it('marks the cookie Secure when the edge terminated TLS', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-https')
      const resp = await exchange(port, link.token, { 'X-Forwarded-Proto': 'https' })
      expect(cookieLine(resp)).toMatch(/;\s*Secure/i)
    })
  })

  it('omits Secure on a plain-http localhost box, where it would be undrinkable', async () => {
    // Safari refuses a Secure cookie over http even on localhost. Setting it
    // unconditionally would break `npm run dev` on a Mac and nowhere else,
    // which is the worst kind of bug to own.
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-plain-http')
      const resp = await exchange(port, link.token)
      expect(cookieLine(resp)).not.toMatch(/;\s*Secure/i)
    })
  })

  it('authorizes an API call with the cookie alone', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-api-cookie')
      const cookie = cookieHeader(await exchange(port, link.token))
      expect(cookie).not.toBe('')

      const ok = await fetch(`http://127.0.0.1:${port}/api/voices`, { headers: { Cookie: cookie } })
      expect(ok.status).toBe(200)

      const anonymous = await fetch(`http://127.0.0.1:${port}/api/voices`)
      expect(anonymous.status).toBe(401)
    })
  })

  it('stops accepting the link token as a bearer credential once it is done', async () => {
    // Time cannot be advanced through an HTTP request, so this drives the
    // link to the same terminal state by revoking it. The clock-based path is
    // in tests/voice-link-grace.test.ts.
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-bearer-dies')

      const before = await fetch(`http://127.0.0.1:${port}/api/voices`, {
        headers: { Authorization: `Bearer ${link.token}` },
      })
      expect(before.status).toBe(200)

      await exchange(port, link.token)
      revokeVoiceLinks('chat-bearer-dies')

      const after = await fetch(`http://127.0.0.1:${port}/api/voices`, {
        headers: { Authorization: `Bearer ${link.token}` },
      })
      expect(after.status).toBe(401)
    })
  })

  it('refuses to mint a session from a token nobody issued, and sets no cookie', async () => {
    await withServer(async (port) => {
      const resp = await exchange(port, 'made-up-token')
      expect(resp.status).toBe(401)
      expect(cookieLine(resp)).toBe('')
    })
  })

  it('will not take the token from the query string, which is where it must stop appearing', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-no-get-exchange')
      const resp = await fetch(
        `http://127.0.0.1:${port}/api/voice-session?token=${encodeURIComponent(link.token)}`,
      )
      expect(resp.status).toBe(404)
      expect(cookieLine(resp)).toBe('')
      // and the link is untouched, so a probe cannot burn someone else's link
      expect(resolveVoiceToken(link.token)).toBe('chat-no-get-exchange')
    })
  })

  it('serves /voice to a returning visitor whose link is already spent', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-return-visit')
      const cookie = cookieHeader(await exchange(port, link.token))

      // Reopening the original Telegram link: the token is dead, the session is not.
      const reopened = await fetch(
        `http://127.0.0.1:${port}/voice?token=${encodeURIComponent(link.token)}`,
        { headers: { Cookie: cookie } },
      )
      expect(reopened.status).toBe(200)

      // A bookmark with no token at all works the same way.
      const bookmarked = await fetch(`http://127.0.0.1:${port}/voice`, { headers: { Cookie: cookie } })
      expect(bookmarked.status).toBe(200)
    })
  })

  it('still refuses /voice to someone with neither a link nor a session', async () => {
    await withServer(async (port) => {
      const resp = await fetch(`http://127.0.0.1:${port}/voice`)
      expect(resp.status).toBe(403)
    })
  })

  it('locks out a live cookie the moment the chat revokes', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-http-revoke')
      const cookie = cookieHeader(await exchange(port, link.token))
      expect((await fetch(`http://127.0.0.1:${port}/api/voices`, { headers: { Cookie: cookie } })).status).toBe(200)

      revokeVoiceLinks('chat-http-revoke')

      expect((await fetch(`http://127.0.0.1:${port}/api/voices`, { headers: { Cookie: cookie } })).status).toBe(401)
      expect((await fetch(`http://127.0.0.1:${port}/voice`, { headers: { Cookie: cookie } })).status).toBe(403)
    })
  })

  it('ignores a cookie that names a session nobody holds', async () => {
    await withServer(async (port) => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/voices`, {
        headers: { Cookie: `${VOICE_COOKIE}=forged-session-id` },
      })
      expect(resp.status).toBe(401)
    })
  })
})

describe('the voice page itself', () => {
  let html: string

  beforeAll(async () => {
    const { readFileSync } = await import('node:fs')
    html = readFileSync(new URL('../public/voice.html', import.meta.url), 'utf-8')
  })

  it('no longer carries the token as a bearer credential', () => {
    // The page used to build `Authorization: Bearer <token from the URL>` on
    // every call. Cookies are attached by the browser, so nothing in the page
    // should be handling the credential at all any more.
    expect(html).not.toContain('Authorization')
    expect(html).not.toContain('Bearer ')
  })

  it('drops the token out of the address bar once it has been exchanged', () => {
    expect(html).toContain('history.replaceState')
    expect(html).toContain('/api/voice-session')
  })
})

describe('the hosted edge', () => {
  it('proxies the exchange route, or hosted boxes 404 what works locally', async () => {
    const { buildCaddyfile } = await import('../src/deploy/teams-edge.js')
    const caddy = buildCaddyfile('havn-test.example.com', { voice: true })
    expect(caddy).toContain('/api/voice-session')
    expect(buildCaddyfile('havn-test.example.com', { voice: false })).not.toContain('/api/voice-session')
  })
})
