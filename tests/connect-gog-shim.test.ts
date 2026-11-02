/**
 * Card #271: the gog wrapper picks the relay token for the account each call
 * names. Runs the generated wrapper for real against a fake gog that reports
 * which token and arguments it was given.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installGogShim, resolveReal } from '../src/connect/gog-shim.js'
import { resolveGogBin, setGogShim } from '../src/infra/gog-bin.js'

const dir = mkdtempSync(join(tmpdir(), 'gog-shim-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// The fake gog: `auth list` prints FAKE_OWN (gog's own sign-ins), anything
// else prints the token it got and its arguments.
const fake = join(dir, 'real-gog')
writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2)
if (a[0] === 'auth' && a[1] === 'list') { process.stdout.write(process.env.FAKE_OWN || ''); process.exit(0) }
process.stdout.write(JSON.stringify({ token: process.env.GOG_ACCESS_TOKEN ?? null, tokens: process.env.GOG_RELAY_TOKENS ?? null, args: a }))
`)
chmodSync(fake, 0o755)

const shim = installGogShim(join(dir, 'bin'), fake, process.execPath, 'linux')!
const TOKENS = JSON.stringify({ 'a@gmail.com': 'TOK-A', 'b@gmail.com': 'TOK-B' })

function gog(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(shim, args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GOG_ACCESS_TOKEN: 'stale-global', ...env } })
  let out: { token: string | null; tokens: string | null; args: string[] } | null = null
  try { out = JSON.parse(r.stdout) } catch { /* auth list or an error */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out }
}

describe('gog wrapper', () => {
  it('gives a named relay account its own token, whichever way the account is named', () => {
    for (const args of [['gmail', 'search', 'x', '--account', 'b@gmail.com'], ['--account=B@Gmail.com', 'gmail', 'search'], ['-a', 'b@gmail.com', 'gmail'], ['-ab@gmail.com', 'gmail']]) {
      const r = gog(args, { GOG_RELAY_TOKENS: TOKENS })
      expect(r.out?.token, args.join(' ')).toBe('TOK-B')
      expect(r.out?.args).toEqual(args)
    }
    expect(gog(['gmail', 'search'], { GOG_RELAY_TOKENS: TOKENS, GOG_ACCOUNT: 'a@gmail.com' }).out?.token).toBe('TOK-A')
  })

  it("leaves an account gog signed in itself on gog's stored token, and never passes the token map on", () => {
    const r = gog(['gmail', 'search', '--account', 'own@x.com'], { GOG_RELAY_TOKENS: TOKENS })
    expect(r.out).toMatchObject({ token: null, tokens: null })
  })

  it('with no account named, uses the only relay account when gog has no sign-ins of its own', () => {
    expect(gog(['gmail', 'search'], { GOG_RELAY_TOKENS: JSON.stringify({ 'a@gmail.com': 'TOK-A' }) }).out?.token).toBe('TOK-A')
  })

  it("with no account named, leaves gog's own default alone when it has sign-ins", () => {
    const r = gog(['gmail', 'search'], { GOG_RELAY_TOKENS: JSON.stringify({ 'a@gmail.com': 'TOK-A' }), FAKE_OWN: 'own@x.com\tdefault\tgmail\t2026\n' })
    expect(r.out?.token).toBeNull()
  })

  it('with several relay accounts and none named, asks for --account instead of guessing', () => {
    const r = gog(['gmail', 'search'], { GOG_RELAY_TOKENS: TOKENS })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('a@gmail.com, b@gmail.com')
    expect(r.stderr).toContain('--account')
  })

  it('lists relay accounts beside its own in auth list, in the plain format discovery parses', () => {
    const r = gog(['auth', 'list', '--plain'], { GOG_RELAY_TOKENS: TOKENS, FAKE_OWN: 'own@x.com\tdefault\tcalendar,gmail\t2026\na@gmail.com\tdefault\tgmail\t2026\n' })
    expect(r.stdout.split('\n').filter(Boolean)).toEqual([
      'own@x.com\tdefault\tcalendar,gmail\t2026',
      'a@gmail.com\tdefault\tgmail\t2026',
      'b@gmail.com\thavn-connect\tcalendar,gmail\trelay',
    ])
  })

  it('passes straight through when nothing is relay-connected', () => {
    const r = gog(['gmail', 'search'])
    expect(r.out).toMatchObject({ token: null, args: ['gmail', 'search'] })
  })
})

describe('installing it', () => {
  it('is skipped on Windows', () => {
    expect(installGogShim(join(dir, 'win'), fake, process.execPath, 'win32')).toBeUndefined()
    expect(existsSync(join(dir, 'win'))).toBe(false)
  })

  it('finds a bare gog on PATH, and an absolute one only if it exists', () => {
    expect(resolveReal('real-gog', `/nope:${dir}`)).toBe(fake)
    expect(resolveReal(fake, '')).toBe(fake)
    expect(resolveReal('/no/such/gog', '')).toBeUndefined()
  })

  it('becomes what resolveGogBin returns, ahead of GOG_BIN, until turned off', () => {
    setGogShim(shim)
    expect(resolveGogBin({ GOG_BIN: '/custom/gog' })).toBe(shim)
    setGogShim(undefined)
    expect(resolveGogBin({ GOG_BIN: '/custom/gog' })).toBe('/custom/gog')
  })
})
