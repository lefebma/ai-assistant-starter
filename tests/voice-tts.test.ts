/**
 * tests/voice-tts.test.ts
 *
 * The voice page used to speak with the browser's speechSynthesis. That is why
 * it carried a sentence chunker, a pause/resume keepalive, a voice picker and a
 * list of strong references: four workarounds for engine limits, none of which
 * an audio file has. It is also why the page's speaker picker never worked, since
 * setSinkId lives on media elements and speechSynthesis output never passes
 * through one.
 *
 * The server speaks now. What is worth pinning:
 *
 * - The edge has to proxy the new route. A path missing from the Caddyfile 404s
 *   on every hosted box while working perfectly in local development, which is
 *   the most expensive kind of bug this repo produces.
 * - The workarounds must stay gone. They are individually plausible-looking
 *   code that someone could reintroduce while "fixing" playback.
 * - The picker must not offer a choice the browser cannot honour.
 *
 * What is NOT tested here, deliberately: a successful /api/speak. Exercising it
 * would either call OpenAI on the developer's key (a real charge, on a machine
 * whose .env has one) or shell out to macOS `say`, which does not exist on two
 * of the three CI platforms. So the handler validates request shape before it
 * checks for an engine, and the rejection paths below are the part that can be
 * proven anywhere.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHttpServer, stopHttpServer } from '../src/http-server.js'
import {
  MAX_TTS_CHARS, truncateForSpeech,
  effectiveVoice, setEffectiveVoice, isOpenAIVoice, OPENAI_VOICES, VOICE_STATE_KEY,
} from '../src/voice.js'
import { buildCaddyfile } from '../src/deploy/teams-edge.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = readFileSync(join(REPO, 'public', 'voice.html'), 'utf-8')

/** The page's script, without the comments that explain what it used to do. */
const PAGE_CODE = PAGE.replace(/^\s*\/\/.*$/gm, '')

// 5100-5300. Two constraints, both learned from this file failing CI: stay off
// the band tests/http-routes.test.ts draws from (3900-4890) so parallel workers
// cannot collide, and stay off fetch's blocked-port list, which includes 4045
// and 4190. A blocked port fails as "bad port" from fetch rather than as
// anything resembling a bind error, and only when the random draw lands on it.
let nextPort = 5100 + Math.floor(Math.random() * 20) * 10

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

describe('POST /api/speak', () => {
  afterEach(async () => {
    await stopHttpServer()
  })

  it('rejects a body that is not JSON', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    })
    expect(resp.status).toBe(400)
    expect((await resp.json()).error).toBe('bad_json')
  })

  it('rejects text that is only whitespace, rather than paying to synthesise it', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   \n  ' }),
    })
    expect(resp.status).toBe(400)
    expect((await resp.json()).error).toBe('empty_text')
  })

  it('rejects a body with no text field', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: 'wrong field' }),
    })
    expect(resp.status).toBe(400)
    expect((await resp.json()).error).toBe('empty_text')
  })
})

describe('the voice a box speaks in', () => {
  it('uses TTS_VOICE when nothing has been chosen', () => {
    expect(effectiveVoice(() => null)).toBe('fable')
  })

  it('prefers a choice made in the UI', () => {
    expect(effectiveVoice(() => 'nova')).toBe('nova')
  })

  it('falls back rather than throwing on a value that is not a voice', () => {
    // It would take a hand-edited database to get one. A box speaking in its
    // default voice beats a box that cannot speak.
    expect(effectiveVoice(() => 'margaret')).toBe('fable')
    expect(effectiveVoice(() => '')).toBe('fable')
  })

  it('stores a chosen voice where an update will not reset it', () => {
    const written: Array<[string, string]> = []
    setEffectiveVoice('shimmer', (k, v) => written.push([k, v]))
    expect(written).toEqual([[VOICE_STATE_KEY, 'shimmer']])
  })

  it('refuses a voice the engine does not have', () => {
    expect(() => setEffectiveVoice('morgan-freeman', () => {})).toThrow(/Unknown voice/)
    expect(isOpenAIVoice('fable')).toBe(true)
    expect(isOpenAIVoice('Fable')).toBe(false)
  })
})

describe('the voice routes', () => {
  afterEach(async () => {
    await stopHttpServer()
  })

  it('reports what this box can speak in, whatever engine it has', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/voices`)
    expect(resp.status).toBe(200)

    // CI has no OpenAI key, and macOS `say` exists on exactly one of the three
    // runners, so the engine is genuinely platform-dependent here. What must
    // hold everywhere: a box that cannot offer a choice offers an empty list
    // rather than names that would do nothing.
    const body = await resp.json()
    if (body.engine === 'openai') {
      expect(body.voices).toContain('fable')
      expect(typeof body.current).toBe('string')
    } else {
      expect(body.voices).toEqual([])
      expect(body.current).toBeNull()
    }
  })

  it('rejects a voice that does not exist, and says what does', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: 'david-attenborough' }),
    })
    expect(resp.status).toBe(400)
    const body = await resp.json()
    expect(body.error).toBe('unknown_voice')
    expect(body.voices).toEqual([...OPENAI_VOICES])
  })

  it('rejects a body that is not JSON', async () => {
    const port = await startServer()
    const resp = await fetch(`http://127.0.0.1:${port}/api/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(resp.status).toBe(400)
    expect((await resp.json()).error).toBe('bad_json')
  })
})

describe('the hosted edge proxies the route', () => {
  it('lists /api/speak, so a hosted box does not 404 what works locally', () => {
    const caddy = buildCaddyfile('havn.example.com', { voice: true })
    expect(caddy).toContain('/api/speak')
    expect(caddy).toContain('/api/transcribe')
  })

  it('lists the voice routes too, or the picker 404s on every hosted box', () => {
    const caddy = buildCaddyfile('havn.example.com', { voice: true })
    // Both, and as separate paths: /api/voices alone would leave the picker
    // able to list voices and unable to change one.
    expect(caddy).toMatch(/\/api\/voices \/api\/voice$/m)
  })

  it('does not expose it when the voice UI is off', () => {
    expect(buildCaddyfile('havn.example.com', { voice: false })).not.toContain('/api/speak')
  })
})

describe('truncateForSpeech', () => {
  it('stays under the limit tts-1 rejects past', () => {
    // OpenAI's tts-1 refuses input longer than 4096 characters. Going over
    // fails the whole reply rather than clipping it.
    expect(MAX_TTS_CHARS).toBeLessThanOrEqual(4096)
  })

  it('leaves an ordinary reply alone', () => {
    expect(truncateForSpeech('Two sentences. That is all.')).toBe('Two sentences. That is all.')
  })

  it('clips a long one and says it clipped', () => {
    const out = truncateForSpeech('x'.repeat(MAX_TTS_CHARS + 500))
    expect(out.length).toBe(MAX_TTS_CHARS + 3)
    expect(out.endsWith('...')).toBe(true)
  })
})

describe('the voice page', () => {
  it('asks the server to speak, with its credential', () => {
    expect(PAGE_CODE).toContain("fetch('/api/speak'")
    expect(PAGE_CODE).toContain('...authHeaders()')
  })

  it('no longer calls speechSynthesis', () => {
    // Comments about it are fine and explain the history; calls are not.
    expect(PAGE_CODE).not.toContain('speechSynthesis')
    expect(PAGE_CODE).not.toContain('SpeechSynthesisUtterance')
  })

  it('has dropped the workarounds that only speechSynthesis needed', () => {
    // Chunking at 180 chars, the pause/resume keepalive, the voice picker, and
    // the strong-reference list. An audio file needs none of them.
    expect(PAGE_CODE).not.toContain('chunkForSpeech')
    expect(PAGE_CODE).not.toContain('KeepAlive')
    expect(PAGE_CODE).not.toContain('pickVoice')
    expect(PAGE_CODE).not.toContain('liveUtterances')
  })

  it('routes playback through an element that can honour the speaker choice', () => {
    expect(PAGE_CODE).toContain('player.setSinkId')
  })

  it('speaks every reply through one element, because iOS permits elements not pages', () => {
    // The bug this replaced: a fresh Audio() per reply, primed by a throwaway
    // probe. iOS clears the gesture requirement on the element that played, so
    // the element that spoke had never been granted anything. Every reply
    // reached the iPhone (200s from /api/speak in the access log) and none of
    // them played. One construction, at page scope, is the whole fix.
    expect(PAGE_CODE.match(/new Audio\(/g) ?? []).toHaveLength(1)
    expect(PAGE_CODE).toContain('const player = new Audio()')
    expect(PAGE_CODE).toContain('player.src = ttsUrl')
  })

  it('primes the element that actually speaks, not a throwaway', () => {
    const unlock = PAGE_CODE.slice(
      PAGE_CODE.indexOf('function unlockAudio'),
      PAGE_CODE.indexOf('function audioSession'),
    )
    expect(unlock).toContain('player.src = SILENT_WAV')
    expect(unlock).toContain('player.play()')
  })

  it('asks iOS for a playback session, and hands it back for capture', () => {
    // The ringer switch mutes an <audio> element and never muted
    // speechSynthesis, so the engine swap could leave a phone silent even with
    // playback permitted. Capture has to have the session back or the mic
    // records nothing.
    expect(PAGE_CODE).toContain("audioSession('playback')")
    expect(PAGE_CODE).toContain("audioSession('play-and-record')")
    expect(PAGE_CODE).toContain('navigator.audioSession')

    const startRec = PAGE_CODE.indexOf('async function startRecording')
    const body = PAGE_CODE.slice(startRec, PAGE_CODE.indexOf('getUserMedia', startRec))
    expect(body).toContain("audioSession('play-and-record')")
  })

  it('offers a tap when playback is refused, rather than going quiet', () => {
    // A phone has no console. Without this, a blocked reply is indistinguishable from a broken assistant.
    expect(PAGE_CODE).toContain('offerTap()')
    expect(PAGE_CODE).toContain('Tap here to hear that reply.')
  })

  it('keeps the audio alive for that tap, and releases it on the next reply', () => {
    // finishSpeaking used to revoke the object URL, which would hand the retry
    // tap a dead src. One blob stays alive until the reply after it.
    const finish = PAGE_CODE.slice(
      PAGE_CODE.indexOf('function finishSpeaking'),
      PAGE_CODE.indexOf('async function fetchSpeech'),
    )
    expect(finish).not.toContain('revokeObjectURL')
    expect(PAGE_CODE).toContain('if (ttsUrl) URL.revokeObjectURL(ttsUrl)')
  })

  it('disables the speaker picker where the browser cannot honour it', () => {
    // Safari and Firefox do not implement setSinkId. A control that silently
    // does nothing is worse than one that says it cannot.
    expect(PAGE_CODE).toContain('SINK_SUPPORTED')
    expect(PAGE_CODE).toContain('speakerSelect.disabled = true')
  })

  it('offers the voice next to the two hardware pickers', () => {
    expect(PAGE).toContain('id="voice-select"')
    expect(PAGE_CODE).toContain("fetch('/api/voices'")
    expect(PAGE_CODE).toContain("fetch('/api/voice'")
  })

  it('still primes audio on a gesture, and never on the one that opens the mic', () => {
    // iOS blocks audio that did not start in a gesture. Priming on the tap that
    // starts recording switches the session to playback and the capture records
    // silence, which is how this page once answered a silent clip in Korean.
    expect(PAGE_CODE).toContain('function unlockAudio')
    const startRec = PAGE_CODE.indexOf('else startRecording()')
    const line = PAGE_CODE.slice(PAGE_CODE.lastIndexOf('\n', startRec), startRec)
    expect(line).not.toContain('unlockAudio')
  })
})
