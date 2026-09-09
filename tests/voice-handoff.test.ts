import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHandoffSeconds, handoffAck } from '../src/http-server.js'
import { buildCaddyfile } from '../src/deploy/teams-edge.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = readFileSync(resolve(ROOT, 'src/http-server.ts'), 'utf-8')

describe('the voice handoff budget', () => {
  it('defaults to 30 seconds', () => {
    // Chosen from measurement, not from a vendor limit: over 49 real agent
    // turns, time to first word had a median of 12.1s and a p90 of 22.3s.
    expect(parseHandoffSeconds(undefined)).toBe(30)
  })

  it('treats 0 as "never hand off" rather than as unset', () => {
    // `parseInt(raw) || 30` reads 0 as missing and hands back the default, so
    // an operator asking voice to wait however long it takes would silently
    // get 30 seconds. Same trap as VOICE_LINK_GRACE_MINUTES.
    expect(parseHandoffSeconds('0')).toBe(0)
  })

  it('falls back on anything that is not a sane number', () => {
    expect(parseHandoffSeconds('')).toBe(30)
    expect(parseHandoffSeconds('soon')).toBe(30)
    expect(parseHandoffSeconds('-5')).toBe(30)
    expect(parseHandoffSeconds('90')).toBe(90)
  })

  it('no longer claims ElevenLabs ends a turn at 15 seconds', () => {
    // There is no such cutoff. ElevenLabs has a soft timeout (0.5-8s) that
    // plays one filler phrase, a backup-LLM cascade timeout (2-15s, which is
    // where the 15 most likely came from), and a max conversation duration
    // defaulting to 600s. Nothing ends a turn at 15. The old comment was the
    // stated reason for a 12s budget that handed roughly half of all voice
    // answers to the chat surface instead of speaking them.
    //
    // The phrase itself is still in the file, quoted inside the correction,
    // which is the point: a retracted claim is worth more with its retraction
    // attached than deleted. What must not survive is the claim standing
    // unchallenged, or the constant it justified.
    expect(SERVER).not.toContain('VOICE_TIMEOUT_MS')
    const claim = SERVER.indexOf('15s hard cutoff')
    if (claim !== -1) {
      expect(SERVER.slice(claim, claim + 400)).toContain('there is no such')
    }
  })
})

describe('what the handoff says', () => {
  it('names the surface the answer is actually going to', () => {
    // It said "I'll send the details to Telegram" on every box, including the
    // Teams boxes this was validated on, where there is no Telegram at all.
    expect(handoffAck('teams')).toContain('Teams')
    expect(handoffAck('teams')).not.toContain('Telegram')
    expect(handoffAck('slack')).toContain('Slack')
    expect(handoffAck('telegram')).toContain('Telegram')
  })

  it('says the same thing whatever the surface, apart from the name', () => {
    const shapes = (['telegram', 'teams', 'slack'] as const).map((p) =>
      handoffAck(p).replace(/Telegram|Teams|Slack/, 'X'),
    )
    expect(new Set(shapes).size).toBe(1)
  })
})

describe('the dead ElevenLabs routes', () => {
  it('no longer serves /api/signed-url or /api/config', () => {
    // Both were reachable and proxied by the hosted edge, and nothing in
    // public/ ever called them. /api/signed-url minted an ElevenLabs signed
    // URL for anyone holding the box credential. Card #118 is archived, so
    // this surface has no consumer and no near-term prospect of one.
    expect(SERVER).not.toContain('/api/signed-url')
    expect(SERVER).not.toContain('/api/config')
    expect(SERVER).not.toContain('handleSignedUrl')
  })

  it('leaves no ElevenLabs plumbing behind in the server', () => {
    expect(SERVER).not.toContain('elevenlabs')
    expect(SERVER).not.toContain('ELEVENLABS')
  })

  it('stops proxying the removed routes at the edge', () => {
    const caddy = buildCaddyfile('havn.example.com', { voice: true })
    expect(caddy).not.toContain('/api/signed-url')
    expect(caddy).not.toContain('/api/config')
    // and still proxies the ones the voice page actually uses
    for (const live of ['/api/transcribe', '/api/speak', '/api/voices', '/api/voice-session']) {
      expect(caddy).toContain(live)
    }
  })
})
