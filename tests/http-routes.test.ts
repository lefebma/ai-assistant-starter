import { describe, it, expect, afterEach } from 'vitest'
import { registerHttpRoute, startHttpServer, stopHttpServer, audioExtension } from '../src/http-server.js'

// A fresh port per test. Reusing one port across start/stop cycles raced on
// Windows CI: rebinding a just-closed port intermittently reset the next
// connection (ECONNRESET), which looked like a route bug and was not one.
// The band matters as much as the freshness. 3900-4890, where this used to
// draw from, contains 4045 and 4190, both on fetch's blocked-port list: a draw
// that landed on either failed the readiness loop for five seconds and then
// threw "fetch failed", which reads exactly like a hung server and is not one.
// 5400-5600 is clear of that list and of the band tests/voice-tts.test.ts uses.
let nextPort = 5400 + Math.floor(Math.random() * 20) * 10

/** Start the server and wait until it actually answers, rather than guessing at a sleep. */
async function startServer(): Promise<number> {
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

describe('registerHttpRoute', () => {
  afterEach(async () => {
    await stopHttpServer()
  })

  it('serves a registered route before the built-in ones and without bearer auth', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('routed')
    })
    const PORT = await startServer()
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('routed')
    unregister()
    const after = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(after.status).toBe(405)
  })

  it('matches method and path exactly', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', (_req, res) => {
      res.writeHead(200)
      res.end('routed')
    })
    const PORT = await startServer()
    const get = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`)
    expect(get.status).not.toBe(200)
    const other = await fetch(`http://127.0.0.1:${PORT}/api/teams/other`, { method: 'POST', body: '{}' })
    expect(other.status).toBe(405)
    unregister()
  })
})

describe('the /voice page gate', () => {
  // The Caddy edge no longer inspects the token, so this route is the only
  // thing standing between a stranger and the voice UI on a hosted box.
  afterEach(async () => {
    await stopHttpServer()
  })

  it('refuses a link nobody minted, and says how to get a real one', async () => {
    const PORT = await startServer()
    const resp = await fetch(`http://127.0.0.1:${PORT}/voice?token=not-a-real-token`)
    expect(resp.status).toBe(403)
    expect(await resp.text()).toMatch(/\/voice ui/)
  })

  it('refuses a request with no token at all', async () => {
    const PORT = await startServer()
    const resp = await fetch(`http://127.0.0.1:${PORT}/voice`)
    expect(resp.status).toBe(403)
  })

})

describe('audioExtension', () => {
  it('maps Safari MP4 recordings to an extension Whisper accepts', () => {
    // Safari cannot record WebM. Writing its MP4 as .webm made Whisper 400
    // with "Invalid file format" on every iPhone recording.
    // Verified against the live API: audio-only ISO-BMFF is rejected as .mp4
    // and accepted as .m4a, regardless of the declared part content type.
    expect(audioExtension('audio/mp4')).toBe('m4a')
    expect(audioExtension('audio/mp4;codecs=mp4a.40.2')).toBe('m4a')
    expect(audioExtension('audio/x-m4a')).toBe('m4a')
  })

  it('maps Chrome and Firefox WebM recordings', () => {
    expect(audioExtension('audio/webm')).toBe('webm')
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm')
  })

  it('ignores case and surrounding whitespace', () => {
    expect(audioExtension(' AUDIO/WEBM ; codecs=opus')).toBe('webm')
  })

  it('falls back to webm when the type is missing or unknown', () => {
    expect(audioExtension(undefined)).toBe('webm')
    expect(audioExtension('')).toBe('webm')
    expect(audioExtension('application/octet-stream')).toBe('webm')
  })

  it('only ever returns a format Whisper supports', () => {
    const supported = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']
    const types = ['audio/webm', 'audio/ogg', 'audio/oga', 'audio/mp4', 'audio/x-m4a', 'audio/m4a',
      'audio/aac', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
      'audio/flac', 'audio/x-flac', 'nonsense', undefined]
    for (const t of types) expect(supported).toContain(audioExtension(t))
    // Never emit .mp4: OpenAI rejects audio-only MP4 under that extension.
    for (const t of types) expect(audioExtension(t)).not.toBe('mp4')
  })
})
