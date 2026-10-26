/**
 * Card #252: dictation from the chat box. The route takes a recording, hands
 * a temp copy to the transcription engine, deletes it, and returns the words.
 * The engine is stubbed, so no paid call is made; /api/web/me carries the
 * flag that tells the page which path to use.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
}))

let port = 0
let server: typeof import('../src/http-server.js')
let dictation: typeof import('../src/web/dictation.js')
let cookie = ''
const TMP = mkdtempSync(join(tmpdir(), 'web-dictation-tmp-'))

/** What the stub engine saw, and what it does next. */
const engine = {
  can: true,
  seen: [] as Array<{ path: string; ext: string; bytes: string; existed: boolean }>,
  fail: false,
  text: '  hello from the microphone  ',
}

const stub: import('../src/web/dictation.js').DictationDeps = {
  canTranscribe: () => engine.can,
  async transcribe(path) {
    engine.seen.push({ path, ext: extname(path), bytes: readFileSync(path, 'utf-8'), existed: existsSync(path) })
    if (engine.fail) throw new Error('OpenAI Whisper returned 500')
    return engine.text
  },
  tmpDir: TMP,
}

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-dictation-store-'))
  const db = await import('../src/db.js')
  db.initDatabase()
  const sessions = await import('../src/web/sessions.js')
  dictation = await import('../src/web/dictation.js')
  server = await import('../src/http-server.js')
  dictation.setDictationDepsForTest(stub)
  // Band 5640-5659: clear of the other HTTP test files' slices.
  port = 5640 + Math.floor(Math.random() * 20)
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
  dictation.setDictationDepsForTest(null)
  await server.stopHttpServer()
})

afterEach(() => {
  engine.can = true
  engine.fail = false
  engine.seen = []
})

const base = () => `http://127.0.0.1:${port}`
const leftovers = () => readdirSync(TMP)

function send(body: BodyInit, headers: Record<string, string> = {}, withCookie = true): Promise<Response> {
  return fetch(base() + '/api/web/dictation', {
    method: 'POST',
    headers: { ...(withCookie ? { Cookie: cookie } : {}), 'X-Havn-Web': '1', 'Content-Type': 'audio/webm;codecs=opus', ...headers },
    body,
  })
}

describe('POST /api/web/dictation', () => {
  it('refuses a caller with no session', async () => {
    const r = await send('audio', {}, false)
    expect(r.status).toBe(401)
    expect(engine.seen).toHaveLength(0)
  })

  it('refuses a request without the upload header', async () => {
    const r = await fetch(base() + '/api/web/dictation', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'audio/webm' }, body: 'audio' })
    expect(r.status).toBe(403)
    expect(engine.seen).toHaveLength(0)
  })

  it('refuses something that is not audio', async () => {
    const r = await send('{}', { 'Content-Type': 'application/json' })
    expect(r.status).toBe(415)
    expect(engine.seen).toHaveLength(0)
  })

  it('says so when the box cannot transcribe', async () => {
    engine.can = false
    const r = await send('audio')
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toBe('transcription_unavailable')
    expect(engine.seen).toHaveLength(0)
  })

  it('returns the words and deletes the recording', async () => {
    const r = await send('fake webm bytes')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ text: 'hello from the microphone' })
    expect(engine.seen).toHaveLength(1)
    expect(engine.seen[0]!.existed).toBe(true)
    expect(engine.seen[0]!.bytes).toBe('fake webm bytes')
    expect(engine.seen[0]!.ext).toBe('.webm')
    expect(existsSync(engine.seen[0]!.path)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('names a Safari recording so the engine can read it', async () => {
    const r = await send('fake mp4 bytes', { 'Content-Type': 'audio/mp4' })
    expect(r.status).toBe(200)
    // OpenAI rejects audio-only MP4 named .mp4 but takes it as .m4a.
    expect(engine.seen[0]!.ext).toBe('.m4a')
    expect(leftovers()).toEqual([])
  })

  it('deletes the recording when transcription fails, and says it failed', async () => {
    engine.fail = true
    const r = await send('fake webm bytes')
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('transcription_failed')
    expect(engine.seen).toHaveLength(1)
    expect(existsSync(engine.seen[0]!.path)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('refuses an empty recording', async () => {
    const r = await send(new Uint8Array(0))
    expect(r.status).toBe(400)
    expect(engine.seen).toHaveLength(0)
    expect(leftovers()).toEqual([])
  })

  it('refuses a recording over the cap by its declared size', async () => {
    const big = new Uint8Array(dictation.MAX_DICTATION_BYTES + 1)
    let status = 0
    try {
      status = (await send(big)).status
    } catch {
      // The server answers 413 and drops the socket; the client may see only the drop.
      status = 413
    }
    expect(status).toBe(413)
    expect(engine.seen).toHaveLength(0)
    expect(leftovers()).toEqual([])
  })

  it('refuses a recording over the cap that does not declare its size', async () => {
    const chunk = new Uint8Array(512 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > dictation.MAX_DICTATION_BYTES + chunk.length) return c.close()
        sent += chunk.length
        c.enqueue(chunk)
      },
    })
    let status = 0
    try {
      const r = await fetch(base() + '/api/web/dictation', {
        method: 'POST',
        headers: { Cookie: cookie, 'X-Havn-Web': '1', 'Content-Type': 'audio/webm' },
        body,
        duplex: 'half',
      } as RequestInit)
      status = r.status
    } catch {
      // The server may drop the socket mid-body once it has answered.
      status = 413
    }
    expect(status).toBe(413)
    expect(engine.seen).toHaveLength(0)
    // The partial file goes once its stream has closed.
    const deadline = Date.now() + 2000
    while (leftovers().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(leftovers()).toEqual([])
  })

  it('caps a recording at a few megabytes and the page at two minutes', () => {
    expect(dictation.MAX_DICTATION_BYTES).toBe(6 * 1024 * 1024)
    expect(dictation.MAX_DICTATION_SECONDS).toBe(120)
  })
})

describe('the dictation flag on /api/web/me', () => {
  it('is true when the box can transcribe', async () => {
    const r = await fetch(base() + '/api/web/me', { headers: { Cookie: cookie } })
    expect(((await r.json()) as { transcribe: boolean }).transcribe).toBe(true)
  })

  it('is false when it cannot, so the page uses the browser or hides the microphone', async () => {
    engine.can = false
    const r = await fetch(base() + '/api/web/me', { headers: { Cookie: cookie } })
    expect(((await r.json()) as { transcribe: boolean }).transcribe).toBe(false)
  })

  it('follows the voice capabilities by default (off on a managed-AI box)', async () => {
    dictation.setDictationDepsForTest(null)
    try {
      const voice = await import('../src/voice.js')
      expect(dictation.dictationDeps().canTranscribe()).toBe(voice.voiceCapabilities().stt)
    } finally {
      dictation.setDictationDepsForTest(stub)
    }
  })
})
