import { describe, it, expect } from 'vitest'
import { createScrubber, secretValuesFromEnv, registerSecret, REDACTED } from '../src/log-redact.js'

const API_KEY = 'zk_live_51Habc123DEF456ghi789JKL'
const PASSWORD = 'abcd-efgh-ijkl-mnop'
const scrub = createScrubber([API_KEY, PASSWORD])

describe('secretValuesFromEnv', () => {
  it('picks only secret-named variables with long enough values', () => {
    const vals = secretValuesFromEnv({
      ANTHROPIC_API_KEY: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa',
      TELEGRAM_BOT_TOKEN: '123456789:AAEhBP0av18Fw1QX9sYk3rDm0qxZc7oM1aB',
      ICLOUD_MAIL_APP_PASSWORD: PASSWORD,
      AZURE_DEVOPS_PAT: 'pat-value-123456',
      LOG_LEVEL: 'debuglevel',
      SHORT_TOKEN: 'abc',
      EMPTY_KEY: '',
      HTTP_PORT: '3000',
    })
    expect(vals).toHaveLength(4)
    expect(vals).not.toContain('debuglevel')
    expect(vals).not.toContain('abc')
  })
})

describe('exact-value layer', () => {
  it('redacts the value anywhere, whatever the surrounding format', () => {
    const cases = [
      `plain ${API_KEY} in a sentence`,
      `https://example.com/v1/call?x=1&k=${API_KEY}&y=2`,
      `{"nested":{"deep":["${API_KEY}"]}}`,
      `line one\nline two has ${PASSWORD}\nline three`,
      `base64ish wrapper [[${API_KEY}]]`,
      `${API_KEY}${API_KEY}`,
    ]
    for (const c of cases) {
      const out = scrub.string(c)
      expect(out).not.toContain(API_KEY)
      expect(out).not.toContain(PASSWORD)
      expect(out).toContain(REDACTED)
    }
  })

  it('handles regex metacharacters inside a secret', () => {
    const odd = createScrubber(['a.b*c+d?e(f)[g]{h}|i^$\\j'])
    expect(odd.string('x a.b*c+d?e(f)[g]{h}|i^$\\j y')).toBe(`x ${REDACTED} y`)
    expect(odd.string('x aXbYYYc y')).toBe('x aXbYYYc y')
  })

  it('replaces the longer secret whole when one contains another', () => {
    const s = createScrubber(['secretvalue', 'secretvalue-extended'])
    expect(s.string('token secretvalue-extended end')).toBe(`token ${REDACTED} end`)
  })

  it('picks up secrets registered at runtime (vault)', () => {
    const s = createScrubber([])
    expect(s.string('vault-only-secret-1234')).toBe('vault-only-secret-1234')
    registerSecret('vault-only-secret-1234')
    expect(s.string('oops vault-only-secret-1234 leaked')).toBe(`oops ${REDACTED} leaked`)
  })

  it('ignores secrets that are too short to be safe to match', () => {
    const s = createScrubber(['abc'])
    expect(s.string('abc and abcdef')).toBe('abc and abcdef')
  })
})

describe('shape layer (credentials we do not know about)', () => {
  const s = createScrubber([])
  it.each([
    ['anthropic', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv rest'],
    ['telegram bare', 'token 123456789:AAEhBP0av18Fw1QX9sYk3rDm0qxZc7oM1aB end'],
    ['telegram in url', 'GET https://api.telegram.org/bot123456789:AAEhBP0av18Fw1QX9sYk3rDm0qxZc7oM1aB/sendMessage 404'],
    // Built at run time so no token-shaped literal sits in the repo (push protection flags it).
    ['slack', ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-')],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['google', 'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('redacts %s', (_label, input) => {
    const out = s.string(input)
    expect(out).toContain(REDACTED)
    expect(out).not.toMatch(/sk-ant-api03-AbCd|AAEhBP0av18|xoxb-1234|ghp_abcdef|AIzaSyA-abcd|eyJzdWIi|abcdefghijklmnopqrstuvwxyz0123456789/)
  })

  it('keeps the Bearer scheme word but drops the credential', () => {
    expect(s.string('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  it('redacts secret-named key/value pairs in env dumps, query strings and JSON', () => {
    expect(s.string('ZOOM_CLIENT_SECRET=hunter2hunter2')).toBe(`ZOOM_CLIENT_SECRET=${REDACTED}`)
    expect(s.string('https://x.test/cb?access_token=abc123def456&state=ok')).toBe(`https://x.test/cb?access_token=${REDACTED}&state=ok`)
    expect(s.string('{"password":"correct-horse-battery","user":"marc"}')).toBe(`{"password":"${REDACTED}","user":"marc"}`)
  })

  it('leaves ordinary log text alone', () => {
    const text = 'Scheduled task completed taskId=2ff93540 nextRun=1790985600 chat 1234567890 tokens used: 1520'
    expect(s.string(text)).toBe(text)
  })
})

describe('deep (structured log objects)', () => {
  it('scrubs strings at any depth and redacts credential-named keys', () => {
    const out = scrub.deep({
      taskId: 'abc',
      req: { headers: { authorization: 'whatever-scheme-and-value', accept: 'json' }, url: `/x?k=${API_KEY}` },
      list: [`one ${PASSWORD}`, 2, null],
      apiKey: 'short',
    })
    expect(out.req.headers.authorization).toBe(REDACTED)
    expect(out.req.headers.accept).toBe('json')
    expect(out.req.url).toBe(`/x?k=${REDACTED}`)
    expect(out.list[0]).toBe(`one ${REDACTED}`)
    expect(out.list[1]).toBe(2)
    expect(out.apiKey).toBe(REDACTED)
    expect(out.taskId).toBe('abc')
  })

  it('does not blank harmless fields that merely look similar', () => {
    const out = scrub.deep({ key: 'cache-key-123', pat: 'pattern', maxTokens: 4096, inputTokens: 12 })
    expect(out).toEqual({ key: 'cache-key-123', pat: 'pattern', maxTokens: 4096, inputTokens: 12 })
  })

  it('scrubs Error message and stack while keeping it an Error', () => {
    const err = new Error(`request failed for key ${API_KEY}\n  at line two ${PASSWORD}`)
    const out = scrub.deep({ err })
    expect(out.err).toBeInstanceOf(Error)
    expect(out.err.message).not.toContain(API_KEY)
    expect(out.err.message).not.toContain(PASSWORD)
    expect(out.err.stack).not.toContain(API_KEY)
    expect(err.message).toContain(API_KEY) // original untouched
  })

  it('scrubs Error cause chains and extra properties', () => {
    const inner = new Error(`inner ${API_KEY}`)
    const outer = Object.assign(new Error('outer', { cause: inner }), { body: `{"token":"${API_KEY}"}` })
    const out = scrub.deep(outer) as Error & { body: string }
    expect((out.cause as Error).message).not.toContain(API_KEY)
    expect(out.body).not.toContain(API_KEY)
  })

  it('survives circular references and never throws', () => {
    const a: Record<string, unknown> = { name: 'a', secretish: API_KEY }
    a.self = a
    expect(() => scrub.deep(a)).not.toThrow()
    const hostile = {
      get boom(): string {
        throw new Error('getter blew up')
      },
    }
    expect(() => scrub.deep(hostile)).not.toThrow()
  })

  it('passes primitives and buffers through', () => {
    expect(scrub.deep(42)).toBe(42)
    expect(scrub.deep(null)).toBeNull()
    const buf = Buffer.from('raw')
    expect(scrub.deep(buf)).toBe(buf)
  })

  it('truncates absurdly long strings instead of regex-scanning megabytes', () => {
    const huge = 'x'.repeat(500_000)
    expect(scrub.string(huge).length).toBeLessThan(250_000)
  })
})

describe('deep fails closed', () => {
  it('scrubs a secret nested deeper than the walk limit', () => {
    const out = JSON.stringify(scrub.deep({ a: { b: { c: { d: { e: { f: { g: { h: `deep ${API_KEY}` } } } } } } } }))
    expect(out).not.toContain(API_KEY)
    expect(out).toContain(REDACTED)
  })

  it('does not hand back the raw value when a getter throws', () => {
    const nasty = { note: `visible ${API_KEY}` }
    Object.defineProperty(nasty, 'boom', { enumerable: true, get() { throw new Error('nope') } })
    const out = JSON.stringify(scrub.deep(nasty))
    expect(out).not.toContain(API_KEY)
  })

  it('marks a true cycle and never returns the raw original', () => {
    const a: Record<string, unknown> = { token: 'short', text: `loop ${API_KEY}` }
    a.self = a
    const out = scrub.deep(a) as Record<string, unknown>
    expect(out.self).toBe('[Circular]')
    expect(JSON.stringify(out)).not.toContain(API_KEY)
  })

  it('scrubs an object that appears twice as siblings', () => {
    const shared = { text: `twice ${API_KEY}` }
    const out = scrub.deep({ one: shared, two: shared }) as { one: { text: string }; two: { text: string } }
    expect(out.one.text).toBe(`twice ${REDACTED}`)
    expect(out.two.text).toBe(`twice ${REDACTED}`)
  })
})

describe('deep fallback keeps the structural rules', () => {
  const tricky = 'pa"ss\\word-with-quote-and-backslash'
  const withTricky = createScrubber([tricky])

  it('still matches an exact secret that JSON would escape, past the walk limit', () => {
    const out = JSON.stringify(withTricky.deep({ a: { b: { c: { d: { e: { f: { g: { note: `x ${tricky} y` } } } } } } } }))
    expect(out).not.toContain('with-quote-and-backslash')
    expect(out).toContain(REDACTED)
  })

  it('blanks a secret-named key past the walk limit', () => {
    const out = JSON.stringify(scrub.deep({ a: { b: { c: { d: { e: { f: { g: { password: 'not-in-the-env-list' } } } } } } } }))
    expect(out).not.toContain('not-in-the-env-list')
  })
})

describe('secret-named keys also blank long numbers, and the fallback scrubs keys', () => {
  it('blanks a numeric PIN under a secret-named key but not a short count', () => {
    const out = scrub.deep({ password: 48151623, token: 42, maxTokens: 4096, req: { authorization: 123456789012 } }) as Record<string, any>
    expect(out.password).toBe(REDACTED)
    expect(out.token).toBe(42)
    expect(out.maxTokens).toBe(4096)
    expect(out.req.authorization).toBe(REDACTED)
  })

  it('does the same past the walk limit', () => {
    const out = JSON.stringify(scrub.deep({ a: { b: { c: { d: { e: { f: { g: { h: { password: 48151623 } } } } } } } } }))
    expect(out).not.toContain('48151623')
  })

  it('scrubs a secret used as an object key past the walk limit', () => {
    const out = JSON.stringify(scrub.deep({ a: { b: { c: { d: { e: { f: { g: { h: { [API_KEY]: 1 } } } } } } } } }))
    expect(out).not.toContain(API_KEY)
  })
})
