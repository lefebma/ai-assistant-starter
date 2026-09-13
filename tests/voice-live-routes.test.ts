/**
 * tests/voice-live-routes.test.ts
 *
 * The live voice page and its API sit behind the same sign-in as /voice: a
 * /voice ui link traded for a session cookie, or the operator bearer. Every
 * live session bills per second and runs agent turns, so an anonymous caller
 * must get nowhere. No real OpenAI call is made: the tests stop at auth and
 * input validation, and at the "no key" answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Read at import time, so set before anything loads config.js or db.js.
const STORE = mkdtempSync(join(tmpdir(), 'havn-voice-live-'))
process.env['AGENT_STORE_DIR'] = STORE
process.env['HTTP_BEARER_TOKEN'] = 'operator-token-for-live-tests'
delete process.env['OPENAI_API_KEY']

let mintVoiceLink: typeof import('../src/voice-links.js').mintVoiceLink
let VOICE_COOKIE: string

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  mintVoiceLink = (await import('../src/voice-links.js')).mintVoiceLink
  VOICE_COOKIE = (await import('../src/voice-sessions.js')).VOICE_COOKIE
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

// 5900-6090 minus fetch's blocked 6000: clear of the other HTTP suites' bands.
let nextPort = 5900 + Math.floor(Math.random() * 9) * 10

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const { startHttpServer, stopHttpServer } = await import('../src/http-server.js')
  const port = nextPort++
  startHttpServer(port)
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
  try {
    await fn(port)
  } finally {
    await stopHttpServer()
  }
}

async function signedInCookie(port: number, chatId: string): Promise<string> {
  const link = mintVoiceLink(chatId)
  const resp = await fetch(`http://127.0.0.1:${port}/api/voice-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: link.token }),
  })
  const line = resp.headers.getSetCookie().find((c) => c.startsWith(`${VOICE_COOKIE}=`)) ?? ''
  return line.split(';')[0] ?? ''
}

describe('/voice/live', () => {
  it('refuses the page to someone with neither a link nor a session', async () => {
    await withServer(async (port) => {
      expect((await fetch(`http://127.0.0.1:${port}/voice/live`)).status).toBe(403)
    })
  })

  it('serves the page to a browser already signed in on /voice', async () => {
    await withServer(async (port) => {
      const cookie = await signedInCookie(port, 'chat-live-page')
      const resp = await fetch(`http://127.0.0.1:${port}/voice/live`, { headers: { Cookie: cookie } })
      expect(resp.status).toBe(200)
      expect(await resp.text()).toContain('/api/live/session')
    })
  })
})

describe('/api/live/*', () => {
  it('rejects an anonymous session request before reading it', async () => {
    await withServer(async (port) => {
      const resp = await fetch(`http://127.0.0.1:${port}/api/live/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: 'v=0' }),
      })
      expect(resp.status).toBe(401)
      expect((await fetch(`http://127.0.0.1:${port}/api/live/status`)).status).toBe(401)
    })
  })

  it('validates the body for a signed-in caller', async () => {
    await withServer(async (port) => {
      const cookie = await signedInCookie(port, 'chat-live-validate')
      const post = (body: string) =>
        fetch(`http://127.0.0.1:${port}/api/live/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body,
        })
      const bad = await post('{not json')
      expect(bad.status).toBe(400)
      expect((await bad.json()).error).toBe('invalid_json')
      const empty = await post(JSON.stringify({ sdp: '  ' }))
      expect(empty.status).toBe(400)
      expect((await empty.json()).error).toBe('sdp_required')
    })
  })

  it('says live voice is off, rather than failing upstream, when the box has no OpenAI key', async () => {
    await withServer(async (port) => {
      const cookie = await signedInCookie(port, 'chat-live-nokey')
      const status = await fetch(`http://127.0.0.1:${port}/api/live/status`, { headers: { Cookie: cookie } })
      expect(status.status).toBe(200)
      const info = await status.json()
      expect(info.enabled).toBe(false)
      expect(info.voices).toContain(info.defaultVoice)

      const resp = await fetch(`http://127.0.0.1:${port}/api/live/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ sdp: 'v=0' }),
      })
      expect(resp.status).toBe(503)
      expect((await resp.json()).error).toBe('openai_not_configured')
    })
  })
})

describe('the hosted edge', () => {
  it('proxies the live page and API when the voice UI is on', async () => {
    const { buildCaddyfile } = await import('../src/deploy/teams-edge.js')
    const caddy = buildCaddyfile('havn.example.com', { voice: true })
    expect(caddy).toContain('/voice/live')
    expect(caddy).toContain('/api/live/session')
    expect(caddy).toContain('/api/live/status')
  })

  it('exposes none of it when the voice UI is off', async () => {
    const { buildCaddyfile } = await import('../src/deploy/teams-edge.js')
    const caddy = buildCaddyfile('havn.example.com', { voice: false })
    expect(caddy).not.toContain('/api/live/')
    expect(caddy).not.toContain('/voice/live')
  })
})
