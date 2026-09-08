import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Read at import time, so both have to be set before config.js or db.js load.
const STORE = mkdtempSync(join(tmpdir(), 'havn-voice-grace-'))
process.env['AGENT_STORE_DIR'] = STORE
process.env['HTTP_BEARER_TOKEN'] = 'operator-token-for-tests'

let mintVoiceLink: typeof import('../src/voice-links.js').mintVoiceLink
let revokeVoiceLinks: typeof import('../src/voice-links.js').revokeVoiceLinks
let exchangeVoiceToken: typeof import('../src/voice-links.js').exchangeVoiceToken
let resolveVoiceToken: typeof import('../src/voice-links.js').resolveVoiceToken
let resolveVoiceSession: typeof import('../src/voice-sessions.js').resolveVoiceSession
let VOICE_LINK_GRACE_MINUTES: number

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  const links = await import('../src/voice-links.js')
  mintVoiceLink = links.mintVoiceLink
  revokeVoiceLinks = links.revokeVoiceLinks
  exchangeVoiceToken = links.exchangeVoiceToken
  resolveVoiceToken = links.resolveVoiceToken
  resolveVoiceSession = (await import('../src/voice-sessions.js')).resolveVoiceSession
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

const MINUTE = 60 * 1000

describe('the grace window after a link is first used', () => {
  it('defaults to ten minutes', () => {
    expect(VOICE_LINK_GRACE_MINUTES).toBe(10)
  })

  it('honours a configured 0, which is the falsy value the shorthand eats', async () => {
    // `parseInt(raw) || 10` reads 0 as "unset" and hands back the default, so
    // an operator asking for strict single use would silently get ten minutes.
    const { parseGraceMinutes } = await import('../src/config.js')
    expect(parseGraceMinutes('0')).toBe(0)
    expect(parseGraceMinutes('30')).toBe(30)
    expect(parseGraceMinutes(undefined)).toBe(10)
    expect(parseGraceMinutes('')).toBe(10)
    expect(parseGraceMinutes('later')).toBe(10)
    expect(parseGraceMinutes('-5')).toBe(10)
  })

  it('signs in a second device opened right after the first', () => {
    // The workflow this exists for: read the message on the machine in front
    // of you, open the link there, then reach for the phone, which is the
    // device the voice page is actually for. 1.23.0 made the second one fail.
    const link = mintVoiceLink('chat-two-devices')
    const laptop = exchangeVoiceToken(link.token)
    const phone = exchangeVoiceToken(link.token)

    expect(laptop).not.toBeNull()
    expect(phone).not.toBeNull()
    expect(phone!.id).not.toBe(laptop!.id)
    expect(resolveVoiceSession(laptop!.id)).toBe('chat-two-devices')
    expect(resolveVoiceSession(phone!.id)).toBe('chat-two-devices')
  })

  it('is measured from first use, not from minting', () => {
    // Someone who sits on a link for eleven hours and then opens it on two
    // devices should get both. The clock that matters starts when they arrive.
    const mintedAt = Date.now()
    const link = mintVoiceLink('chat-late-arrival', mintedAt)
    const arrived = mintedAt + 11 * 60 * MINUTE

    expect(exchangeVoiceToken(link.token, arrived)).not.toBeNull()
    expect(exchangeVoiceToken(link.token, arrived + 2 * MINUTE)).not.toBeNull()
  })

  it('closes once the window has passed', () => {
    const now = Date.now()
    const link = mintVoiceLink('chat-grace-closes', now)
    expect(exchangeVoiceToken(link.token, now)).not.toBeNull()

    const late = now + (VOICE_LINK_GRACE_MINUTES + 1) * MINUTE
    expect(exchangeVoiceToken(link.token, late)).toBeNull()
  })

  it('never outlives the link itself', () => {
    // A link opened one minute before it expires does not get ten more.
    const now = Date.now()
    const link = mintVoiceLink('chat-grace-capped', now)
    const justBefore = link.expiresAt - MINUTE
    expect(exchangeVoiceToken(link.token, justBefore)).not.toBeNull()
    expect(exchangeVoiceToken(link.token, link.expiresAt + 1)).toBeNull()
  })

  it('leaves the page reachable for the second device, and shuts it after', () => {
    // resolveVoiceToken is what the /voice gate asks. If a used token stopped
    // opening the page the moment it was spent, the phone could not load the
    // page it needs in order to exchange at all.
    const now = Date.now()
    const link = mintVoiceLink('chat-gate-follows-grace', now)
    exchangeVoiceToken(link.token, now)

    expect(resolveVoiceToken(link.token, now + MINUTE)).toBe('chat-gate-follows-grace')
    expect(resolveVoiceToken(link.token, now + (VOICE_LINK_GRACE_MINUTES + 1) * MINUTE)).toBeNull()
  })

  it('still revokes every device the link signed in', () => {
    const link = mintVoiceLink('chat-grace-revoke')
    const first = exchangeVoiceToken(link.token)!
    const second = exchangeVoiceToken(link.token)!

    expect(revokeVoiceLinks('chat-grace-revoke')).toBeGreaterThan(0)
    expect(resolveVoiceSession(first.id)).toBeNull()
    expect(resolveVoiceSession(second.id)).toBeNull()
    expect(resolveVoiceToken(link.token)).toBeNull()
  })

  it('still refuses a token nobody minted', () => {
    expect(exchangeVoiceToken('never-issued')).toBeNull()
  })
})

describe('what the page is told, so it can say something true', () => {
  // 5900-6090 avoids the 5100, 5400 and 5700 bands the other HTTP suites draw
  // from. It stops short of 6000 in the draw (6000 is on fetch's blocked-port
  // list) by using a 10-slot band.
  let nextPort = 5900 + Math.floor(Math.random() * 10) * 10

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

  it('gives a spent link a 401, which is a different problem from a 404', async () => {
    // A 404 means this box's edge never proxied the route and the operator has
    // to re-run the edge script. A 401 means the link is genuinely done. The
    // page reported both as "expired", which sent the wrong person looking.
    await withServer(async (port) => {
      const now = Date.now()
      const link = mintVoiceLink('chat-status-codes', now)
      const ok = await fetch(`http://127.0.0.1:${port}/api/voice-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: link.token }),
      })
      expect(ok.status).toBe(200)

      // Force the window shut by revoking, which is the same terminal state.
      revokeVoiceLinks('chat-status-codes')
      const spent = await fetch(`http://127.0.0.1:${port}/api/voice-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: link.token }),
      })
      expect(spent.status).toBe(401)
    })
  })

  it('signs in two browsers off one link, over real HTTP', async () => {
    await withServer(async (port) => {
      const link = mintVoiceLink('chat-http-two-devices')
      const cookies: string[] = []
      for (const _device of [1, 2]) {
        const resp = await fetch(`http://127.0.0.1:${port}/api/voice-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: link.token }),
        })
        expect(resp.status).toBe(200)
        cookies.push((resp.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '')
      }
      expect(cookies[0]).not.toBe(cookies[1])
      for (const cookie of cookies) {
        const resp = await fetch(`http://127.0.0.1:${port}/api/voices`, { headers: { Cookie: cookie } })
        expect(resp.status).toBe(200)
      }
    })
  })
})

describe('the voice page tells the truth about which thing went wrong', () => {
  let html: string

  beforeAll(async () => {
    const { readFileSync } = await import('node:fs')
    html = readFileSync(new URL('../public/voice.html', import.meta.url), 'utf-8')
  })

  it('names the operator problem when the sign-in route is not proxied', () => {
    expect(html).toContain('404')
    expect(html).toMatch(/edge|operator/i)
  })

  it('does not call a spent link an expired one', () => {
    // Four situations used to render as "This voice link has expired": a 404
    // from the edge, a used-up link, a revoked session, and arriving with no
    // link at all. Only one of them was expiry.
    expect(html).toMatch(/already (been )?used|already signed/i)
  })

  it('still handles the case of no link at all', () => {
    expect(html).toContain('/voice ui')
  })
})
