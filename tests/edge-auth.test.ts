/**
 * tests/edge-auth.test.ts
 *
 * A box with a public edge must never serve its HTTP API without a credential.
 * On 2026-09-13 a hosted box had its edge opened with no HTTP_BEARER_TOKEN in
 * .env, and chat completions, live sessions, transcription and speech answered
 * anyone on the internet. decideAuth now only treats a missing token as "open"
 * for a plainly local caller, and enable-teams generates a token first.
 */
import { describe, it, expect } from 'vitest'
import { decideAuth } from '../src/http-server.js'
import { ensureBearerToken } from '../src/deploy/teams-edge.js'

const base = { boxToken: '', presented: '', linkChat: null, sessionChat: null, publicHostname: '', proxied: false }

describe('decideAuth', () => {
  it('keeps a local-only box with no token open, as before', () => {
    expect(decideAuth(base)).toEqual({ ok: true, chatId: null })
  })

  it('refuses a caller with no credential once the box has a public hostname', () => {
    expect(decideAuth({ ...base, publicHostname: '5-161-197-79.sslip.io' }).ok).toBe(false)
  })

  it('refuses a proxied caller with no credential even without a recorded hostname', () => {
    expect(decideAuth({ ...base, proxied: true }).ok).toBe(false)
  })

  it('still admits voice links and sessions on a public box with no token', () => {
    const pub = { ...base, publicHostname: 'box.example.com', proxied: true }
    expect(decideAuth({ ...pub, presented: 'link-token', linkChat: 'chat-1' })).toEqual({ ok: true, chatId: 'chat-1' })
    expect(decideAuth({ ...pub, sessionChat: 'chat-2' })).toEqual({ ok: true, chatId: 'chat-2' })
  })

  it('does not let an empty presented token match an empty box token', () => {
    expect(decideAuth({ ...base, publicHostname: 'box.example.com', presented: '' }).ok).toBe(false)
  })

  it('accepts the box token and rejects a wrong one', () => {
    const withToken = { ...base, boxToken: 's3cret', publicHostname: 'box.example.com', proxied: true }
    expect(decideAuth({ ...withToken, presented: 's3cret' })).toEqual({ ok: true, chatId: null })
    expect(decideAuth({ ...withToken, presented: 'nope' }).ok).toBe(false)
    expect(decideAuth({ ...base, boxToken: 's3cret' }).ok).toBe(false)
  })
})

describe('ensureBearerToken', () => {
  const gen = () => 'GENERATED'

  it('appends a token when the key is absent, keeping the rest of the file', () => {
    const { content, generated } = ensureBearerToken('TELEGRAM_BOT_TOKEN=abc\nPUBLIC_HOSTNAME=x\n', gen)
    expect(generated).toBe(true)
    expect(content).toContain('TELEGRAM_BOT_TOKEN=abc\nPUBLIC_HOSTNAME=x\n')
    expect(content).toMatch(/^HTTP_BEARER_TOKEN=GENERATED$/m)
    expect(content.endsWith('\n')).toBe(true)
  })

  it('fills in an empty or quoted-empty value in place', () => {
    for (const blank of ['HTTP_BEARER_TOKEN=', 'HTTP_BEARER_TOKEN=""', 'HTTP_BEARER_TOKEN=  ']) {
      const { content, generated } = ensureBearerToken(`A=1\n${blank}\nB=2\n`, gen)
      expect(generated).toBe(true)
      expect(content).toBe('A=1\nHTTP_BEARER_TOKEN=GENERATED\nB=2\n')
    }
  })

  it('never replaces an existing token', () => {
    const env = 'HTTP_BEARER_TOKEN=keepme\n'
    expect(ensureBearerToken(env, gen)).toEqual({ content: env, generated: false })
    expect(ensureBearerToken('HTTP_BEARER_TOKEN="quoted"\n', gen).generated).toBe(false)
  })

  it('handles a file with no trailing newline', () => {
    const { content } = ensureBearerToken('A=1', gen)
    expect(content.startsWith('A=1\n')).toBe(true)
    expect(content).toMatch(/^HTTP_BEARER_TOKEN=GENERATED$/m)
  })
})
