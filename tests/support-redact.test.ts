import { describe, it, expect } from 'vitest'
import { redactSensitive } from '../src/support/redact.js'

describe('redactSensitive', () => {
  it('strips KEY=value secrets but keeps the key name for debugging', () => {
    const out = redactSensitive('boot with TELEGRAM_BOT_TOKEN=8123456789:AAHrealLookingTokenValue12345678901 ok')
    expect(out).not.toContain('AAHrealLookingTokenValue12345678901')
    expect(out).toContain('TELEGRAM_BOT_TOKEN=')
    expect(out).toContain('[redacted]')
  })

  it('strips colon-separated secrets (yaml / prose style)', () => {
    const out = redactSensitive('config password: hunter2 loaded')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('password:')
  })

  it('strips JSON-style quoted secret values', () => {
    const out = redactSensitive('{"apiKey":"sk_live_abcdef123456","level":50}')
    expect(out).not.toContain('sk_live_abcdef123456')
    expect(out).toContain('apiKey')
    // Non-secret JSON fields survive
    expect(out).toContain('"level":50')
  })

  it('strips bearer credentials', () => {
    const out = redactSensitive('retrying with Bearer dXNlcjpwYXNzd29yZDEyMw== header')
    expect(out).not.toContain('dXNlcjpwYXNzd29yZDEyMw==')
    expect(out).toMatch(/Bearer \[redacted\]/i)
  })

  it('strips full Authorization headers including JWTs', () => {
    const out = redactSensitive(
      'sending Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload1234.sig567890 now'
    )
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).toContain('Authorization')
  })

  it('strips well-known token shapes even without a key= prefix', () => {
    // Token shapes are assembled at runtime so secret scanners (GitHub push
    // protection, and any user's own scanning on forks) never match these
    // fixtures as literal secrets. The redactor still sees the real shape.
    const samples = [
      ['sk-ant-api03-', 'averyveryverylongsecretkeyvalue'].join(''),
      ['xox', 'b-1234567890-abcdefghijklmnop'].join(''),
      ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
      ['AIza', 'SyA-abcdefghijklmnopqrstuvwxyz1234567'].join(''),
    ]
    for (const s of samples) {
      const out = redactSensitive(`saw ${s} in flight`)
      expect(out, s).not.toContain(s)
      expect(out, s).toContain('[redacted]')
    }
  })

  it('strips long hex blobs (session ids, raw keys)', () => {
    const hex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const out = redactSensitive(`session ${hex} expired`)
    expect(out).not.toContain(hex)
  })

  it('strips email addresses harvested from logs', () => {
    const out = redactSensitive('IMAP sync failed for marc.lefebvre20@gmail.com after 3 tries')
    expect(out).not.toContain('marc.lefebvre20@gmail.com')
    expect(out).toContain('[email redacted]')
    expect(out).toContain('IMAP sync failed')
  })

  it('leaves ordinary log lines alone', () => {
    const line = 'ERROR: failed to reach api.telegram.org: ETIMEDOUT after 30000ms (attempt 3/5)'
    expect(redactSensitive(line)).toBe(line)
  })

  it('handles multi-line excerpts, redacting each occurrence', () => {
    const raw = [
      'ERROR gog auth failed for user@example.com',
      'ERROR retry with OPENAI_API_KEY=sk-proj-longsecretvaluehere123',
      'ERROR giving up',
    ].join('\n')
    const out = redactSensitive(raw)
    expect(out).not.toContain('user@example.com')
    expect(out).not.toContain('sk-proj-longsecretvaluehere123')
    expect(out).toContain('ERROR giving up')
  })
})
