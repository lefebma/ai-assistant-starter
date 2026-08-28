import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STORE_DIR is read at config import time, so the temp dir has to be set before
// anything pulls in db.js.
const STORE = mkdtempSync(join(tmpdir(), 'havn-voice-links-'))
process.env['AGENT_STORE_DIR'] = STORE

let mintVoiceLink: typeof import('../src/voice-links.js').mintVoiceLink
let resolveVoiceToken: typeof import('../src/voice-links.js').resolveVoiceToken
let revokeVoiceLinks: typeof import('../src/voice-links.js').revokeVoiceLinks
let voiceLinkUrl: typeof import('../src/voice-links.js').voiceLinkUrl
let voiceLinkMessage: typeof import('../src/voice-links.js').voiceLinkMessage

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  const mod = await import('../src/voice-links.js')
  mintVoiceLink = mod.mintVoiceLink
  resolveVoiceToken = mod.resolveVoiceToken
  revokeVoiceLinks = mod.revokeVoiceLinks
  voiceLinkUrl = mod.voiceLinkUrl
  voiceLinkMessage = mod.voiceLinkMessage
})

afterAll(async () => {
  // Windows will not unlink an open SQLite file, so close the handle before
  // removing the directory. Even after close it can hold the -wal/-shm briefly,
  // so a failed cleanup of a temp dir is not worth failing the suite over.
  try {
    const { getDb } = await import('../src/db.js')
    getDb().close()
  } catch {
    // no handle to close
  }
  try {
    rmSync(STORE, { recursive: true, force: true })
  } catch {
    // the OS reaps its own temp directory
  }
})

describe('voice links', () => {
  it('mints a token that resolves back to its own chat', () => {
    const link = mintVoiceLink('chat-a')
    expect(link.token).toHaveLength(43) // 32 random bytes, base64url
    expect(resolveVoiceToken(link.token)).toBe('chat-a')
  })

  it('does not resolve a token nobody minted', () => {
    expect(resolveVoiceToken('made-up')).toBeNull()
    expect(resolveVoiceToken('')).toBeNull()
  })

  it('keeps two chats apart, so one link never reaches the other assistant', () => {
    const a = mintVoiceLink('chat-a')
    const b = mintVoiceLink('chat-b')
    expect(a.token).not.toBe(b.token)
    expect(resolveVoiceToken(a.token)).toBe('chat-a')
    expect(resolveVoiceToken(b.token)).toBe('chat-b')
  })

  it('invalidates the previous link when a chat mints a new one', () => {
    const first = mintVoiceLink('chat-c')
    const second = mintVoiceLink('chat-c')
    expect(resolveVoiceToken(first.token)).toBeNull()
    expect(resolveVoiceToken(second.token)).toBe('chat-c')
  })

  it('stops resolving a token once it expires', () => {
    const link = mintVoiceLink('chat-d')
    const afterExpiry = link.expiresAt + 1
    expect(resolveVoiceToken(link.token, afterExpiry)).toBeNull()
    // Still dead when the clock is back to normal: the lookup dropped the row.
    expect(resolveVoiceToken(link.token)).toBeNull()
  })

  it('revokes on request and reports whether there was anything to revoke', () => {
    mintVoiceLink('chat-e')
    expect(revokeVoiceLinks('chat-e')).toBe(1)
    expect(revokeVoiceLinks('chat-e')).toBe(0)
  })

  it('revoking one chat leaves other chats alone', () => {
    const keep = mintVoiceLink('chat-f')
    mintVoiceLink('chat-g')
    revokeVoiceLinks('chat-g')
    expect(resolveVoiceToken(keep.token)).toBe('chat-f')
  })
})

describe('voice link presentation', () => {
  it('builds an https URL with the token in the query', () => {
    expect(voiceLinkUrl('havn.example.com', 'tok123')).toBe(
      'https://havn.example.com/voice?token=tok123'
    )
  })

  it('escapes a token so a stray character cannot alter the query', () => {
    expect(voiceLinkUrl('h.example.com', 'a&b=c')).toBe('https://h.example.com/voice?token=a%26b%3Dc')
  })

  it('warns that the link is a credential, since that is the only warning a user gets', () => {
    const now = 1_000_000
    const msg = voiceLinkMessage('https://h.example.com/voice?token=t', now + 12 * 3600 * 1000, now)
    expect(msg).toContain('https://h.example.com/voice?token=t')
    expect(msg).toContain('Expires in 12h')
    expect(msg).toMatch(/password|don't forward/i)
    expect(msg).toContain('/voice ui revoke')
  })
})

describe('the /voice page gate, end to end', () => {
  // The 403 cases live in http-routes.test.ts; these need a real minted link,
  // so they run here where AGENT_STORE_DIR points at a temp database.
  const PORT = 3800 + Math.floor(Math.random() * 100)

  it('serves the page to a minted link and stops once it is revoked', async () => {
    const { startHttpServer, stopHttpServer } = await import('../src/http-server.js')
    const link = mintVoiceLink('route-chat')
    startHttpServer(PORT)
    await new Promise((r) => setTimeout(r, 10))
    try {
      const ok = await fetch(`http://127.0.0.1:${PORT}/voice?token=${encodeURIComponent(link.token)}`)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('<html')

      revokeVoiceLinks('route-chat')
      const gone = await fetch(`http://127.0.0.1:${PORT}/voice?token=${encodeURIComponent(link.token)}`)
      expect(gone.status).toBe(403)
    } finally {
      await stopHttpServer()
    }
  })

  it('will not open one chat\'s page with another chat\'s link revoked out from under it', async () => {
    const { startHttpServer, stopHttpServer } = await import('../src/http-server.js')
    const mine = mintVoiceLink('chat-mine')
    const theirs = mintVoiceLink('chat-theirs')
    revokeVoiceLinks('chat-theirs')
    startHttpServer(PORT + 1)
    await new Promise((r) => setTimeout(r, 10))
    try {
      const a = await fetch(`http://127.0.0.1:${PORT + 1}/voice?token=${encodeURIComponent(mine.token)}`)
      expect(a.status).toBe(200)
      const b = await fetch(`http://127.0.0.1:${PORT + 1}/voice?token=${encodeURIComponent(theirs.token)}`)
      expect(b.status).toBe(403)
    } finally {
      await stopHttpServer()
    }
  })
})
