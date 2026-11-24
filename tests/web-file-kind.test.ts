import { describe, it, expect } from 'vitest'
import { kindFromName, kindFromMime, rawHeaders, dispositionName } from '../src/web/file-kind.js'
import * as page from '../public/app/filekind.js'

const NAMES: Array<[string, string]> = [
  ['a.PNG', 'image'],
  ['a.pdf', 'pdf'],
  ['a.md', 'markdown'],
  ['a.csv', 'text'],
  ['a.docx', 'other'],
  ['noext', 'other'],
]
const MIMES: Array<[string, string]> = [
  ['image/jpeg', 'image'],
  ['application/vnd.google-apps.document', 'pdf'],
  ['application/vnd.google-apps.form', 'other'],
  ['text/markdown', 'markdown'],
  ['application/zip', 'other'],
]

describe('file kind', () => {
  it.each(NAMES)('kindFromName(%s) is %s', (n, k) => expect(kindFromName(n).kind).toBe(k))
  it.each(MIMES)('kindFromMime(%s) is %s', (m, k) => expect(kindFromMime(m).kind).toBe(k))

  it('a PDF may be framed by our own page only', () => {
    const h = rawHeaders('pdf', 'application/pdf', 'a.pdf', 10)
    expect(h['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'self'")
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN')
  })

  it('unknown kinds are attachments and every answer is nosniff', () => {
    const h = rawHeaders('other', 'application/octet-stream', 'a.zip', 10)
    expect(String(h['Content-Disposition'])).toMatch(/^attachment/)
    for (const [kind, mime] of [['image', 'image/png'], ['pdf', 'application/pdf'], ['text', 'text/plain'], ['other', 'x/y']] as const) {
      expect(rawHeaders(kind, mime, 'a', 1)['X-Content-Type-Options']).toBe('nosniff')
    }
  })

  it('text over 1 MB is an attachment', () => {
    const big = rawHeaders('text', 'text/plain', 'a.txt', 1024 * 1024 + 1)
    expect(String(big['Content-Disposition'])).toMatch(/^attachment/)
    const ok = rawHeaders('text', 'text/plain', 'a.txt', 1024 * 1024)
    expect(String(ok['Content-Disposition'])).toMatch(/^inline/)
    expect(ok['Content-Type']).toBe('text/plain; charset=utf-8')
  })

  it('svg keeps its restrictive CSP and names are made safe', () => {
    expect(rawHeaders('image', 'image/svg+xml', 'a.svg', 1)['Content-Security-Policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(dispositionName('a"b\r\n.txt')).toBe('a_b__.txt')
  })

  it('the page helper agrees with the server for every row above', () => {
    for (const [n] of NAMES) expect(page.kindFromName(n)).toBe(kindFromName(n).kind)
    for (const [m] of MIMES) expect(page.kindFromMime(m)).toBe(kindFromMime(m).kind)
  })
})
