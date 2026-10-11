import { describe, it, expect, afterEach } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { createSetupServer, type SetupMode } from '../src/setup/web/server.js'
import { issueLink, type LinkState, type LinkStore } from '../src/setup/web/link.js'
import { BOT_TOKEN, fakeTelegram } from './web-setup-fakes.js'

const REPO = resolve(__dirname, '..')
const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'

function memStore(): LinkStore & { state: LinkState | null } {
  const s = { state: null as LinkState | null, read: () => s.state, write: (v: LinkState) => void (s.state = v) }
  return s
}

const open: Server[] = []
afterEach(() => {
  for (const s of open.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
})

async function boot(mode: SetupMode, opts: { now?: () => number; signedIn?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'web-setup-'))
  cpSync(join(REPO, 'templates'), join(root, 'templates'), { recursive: true })
  const tg = fakeTelegram()
  const vault = new Map<string, string>()
  const links = memStore()
  let finished = 0
  let signInStarted = 0
  const now = opts.now ?? Date.now
  const server = createSetupServer({
    mode,
    projectRoot: root,
    home: root,
    fetch: tg.f,
    vault: { set: (k, v) => void vault.set(k, v) },
    links,
    now,
    page: () => readFileSync(join(REPO, 'templates', 'web-setup', 'index.html'), 'utf-8'),
    claude: { available: true, signedIn: () => opts.signedIn ?? false, start: () => void signInStarted++ },
    onFinished: () => void finished++,
    pollSeconds: 0,
  })
  open.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const token = mode === 'hosted' ? issueLink(links, now()) : ''
  const req = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra }
    if (token && !path.includes('?token=')) headers['authorization'] = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  return { root, tg, vault, links, token, base, req, finished: () => finished, signInStarted: () => signInStarted }
}

async function pairOwner(t: Awaited<ReturnType<typeof boot>>) {
  expect((await t.req('/setup/api/telegram/token', { token: BOT_TOKEN })).status).toBe(200)
  // Let the pairing take its baseline before the owner taps Start.
  await new Promise((r) => setTimeout(r, 30))
  t.tg.push({ chatId: 4242, date: Math.floor(Date.now() / 1000) + 1, first: 'Leif', username: 'leifb' })
  for (let i = 0; i < 100; i++) {
    const p = (await (await t.req('/setup/api/telegram/pairing')).json()) as { state: string }
    if (p.state === 'found') break
    await new Promise((r) => setTimeout(r, 10))
  }
  const c = (await (await t.req('/setup/api/telegram/confirm', { yes: true })).json()) as { state: string; name: string }
  expect(c).toMatchObject({ state: 'paired', name: 'Leif' })
}

const PROFILE = { ownerName: 'Leif Becker', assistantName: 'Avery', timezone: 'America/New_York', city: 'Toronto', vibe: 2, ownerBio: 'I run an AI consultancy.' }

describe('web setup, hosted', () => {
  it('404s the page and the API without the link token', async () => {
    const t = await boot('hosted')
    expect((await fetch(`${t.base}/setup`)).status).toBe(404)
    expect((await fetch(`${t.base}/setup?token=wrong`)).status).toBe(404)
    expect((await fetch(`${t.base}/setup/api/state`)).status).toBe(404)
    expect((await fetch(`${t.base}/setup/api/state`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(404)
  })

  it('serves the page with the token, with a nonce CSP and no-referrer', async () => {
    const t = await boot('hosted')
    const res = await fetch(`${t.base}/setup?token=${t.token}`)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy')!
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!
    const html = await res.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).not.toContain('{{NONCE}}')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('tells an expired link apart from a wrong one', async () => {
    let clock = Date.now()
    const t = await boot('hosted', { now: () => clock })
    clock += 49 * 60 * 60 * 1000
    const res = await fetch(`${t.base}/setup?token=${t.token}`)
    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/expired/)
  })

  it('rate-limits a client sending bad tokens, without locking out the real link', async () => {
    const t = await boot('hosted')
    const from = { 'x-forwarded-for': '203.0.113.9' }
    for (let i = 0; i < 20; i++) await fetch(`${t.base}/setup?token=bad${i}`, { headers: from })
    expect((await fetch(`${t.base}/setup?token=bad`, { headers: from })).status).toBe(429)
    expect((await fetch(`${t.base}/setup?token=bad`, { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(404)
    expect((await fetch(`${t.base}/setup?token=${t.token}`, { headers: from })).status).toBe(200)
  })

  it('consumes the link even when the hello message cannot be sent', async () => {
    const t = await boot('hosted')
    await pairOwner(t)
    t.tg.failSend = true
    const res = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'later' } })
    expect(await res.json()).toMatchObject({ ok: true, delivered: false })
    expect(t.links.state).toMatchObject({ hash: null })
  })

  it('does not offer a Claude subscription sign-in on a hosted box', async () => {
    const t = await boot('hosted')
    const s = (await (await t.req('/setup/api/state')).json()) as { subscription: unknown }
    expect(s.subscription).toBeNull()
    await pairOwner(t)
    const r = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'subscription' } })
    expect(r.status).toBe(400)
  })

  it('finishes: secrets in the vault only, config written, hello sent, link consumed, then 404', async () => {
    const t = await boot('hosted')
    await pairOwner(t)
    const res = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'api-key', provider: 'openai', key: OPENAI_KEY } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, bot: 'avery_test_bot', delivered: true, city: 'Toronto, Ontario, Canada' })

    expect(t.vault.get('TELEGRAM_BOT_TOKEN')).toBe(BOT_TOKEN)
    expect(t.vault.get('OPENAI_API_KEY')).toBe(OPENAI_KEY)
    const env = readFileSync(join(t.root, '.env'), 'utf-8')
    expect(env).not.toContain(BOT_TOKEN)
    expect(env).not.toContain(OPENAI_KEY)
    expect(env).toMatch(/^ALLOWED_CHAT_ID=4242$/m)
    expect(env).toMatch(/^AI_PROVIDER=openai$/m)
    expect(env).toMatch(/^AI_MODEL=gpt-5$/m)
    expect(env).toMatch(/^TIMEZONE=America\/New_York$/m)
    expect(existsSync(join(t.root, 'CLAUDE.md'))).toBe(true)
    expect(readFileSync(join(t.root, 'skills', 'weather', 'manifest.json'), 'utf-8')).toContain('43.70')

    expect(t.tg.sent).toEqual([{ chat_id: 4242, text: expect.stringContaining("Hi Leif Becker, I'm Avery.") }])
    expect(t.links.state).toMatchObject({ hash: null })
    await new Promise((r) => setImmediate(r))
    expect(t.finished()).toBe(1)

    expect((await fetch(`${t.base}/setup?token=${t.token}`)).status).toBe(404)
    expect((await t.req('/setup/api/state')).status).toBe(404)
  })

  it('refuses to finish before Telegram is paired', async () => {
    const t = await boot('hosted')
    const r = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'later' } })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'Connect Telegram first.' })
  })

  it('refuses to overwrite an install that is already set up', async () => {
    const t = await boot('hosted')
    writeFileSync(join(t.root, '.env'), 'EXISTING=1\n')
    await pairOwner(t)
    const r = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'later' } })
    expect(r.status).toBe(409)
    expect(readFileSync(join(t.root, '.env'), 'utf-8')).toBe('EXISTING=1\n')
    expect(t.vault.size).toBe(0)
  })

  it('rejects POSTs that are not JSON (no cross-site form posts)', async () => {
    const t = await boot('hosted')
    const r = await fetch(`${t.base}/setup/api/telegram/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${BOT_TOKEN}`,
    })
    expect(r.status).toBe(400)
    expect(t.tg.calls).toEqual([])
  })

  it('never echoes a bad input back with secrets in it', async () => {
    const t = await boot('hosted')
    await pairOwner(t)
    const r = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'api-key', provider: 'openai', key: 'short' } })
    const body = await r.text()
    expect(r.status).toBe(400)
    expect(body).not.toContain('short')
  })
})

describe('web setup, local', () => {
  it('only answers requests addressed to localhost, never proxied ones', async () => {
    const t = await boot('local')
    expect((await t.req('/setup')).status).toBe(200)
    // fetch will not send a custom Host, which is the DNS-rebinding case.
    const status = await new Promise<number>((done) => {
      const u = new URL(t.base)
      request({ host: u.hostname, port: u.port, path: '/setup', headers: { host: 'evil.example' } }, (res) => {
        res.resume()
        done(res.statusCode ?? 0)
      }).end()
    })
    expect(status).toBe(404)
    expect((await t.req('/setup', undefined, { 'x-forwarded-for': '1.2.3.4' })).status).toBe(404)
  })

  it('offers the Claude sign-in and requires it before finishing on the subscription', async () => {
    const t = await boot('local', { signedIn: false })
    const s = (await (await t.req('/setup/api/state')).json()) as { subscription: { signedIn: boolean } }
    expect(s.subscription).toEqual({ signedIn: false })
    await t.req('/setup/api/claude/sign-in', {})
    expect(t.signInStarted()).toBe(1)
    await pairOwner(t)
    expect((await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'subscription' } })).status).toBe(400)
  })

  it('finishes on the subscription once signed in, with no key anywhere', async () => {
    const t = await boot('local', { signedIn: true })
    await pairOwner(t)
    const r = await t.req('/setup/api/finish', { profile: PROFILE, engine: { kind: 'subscription' } })
    expect(r.status).toBe(200)
    expect([...t.vault.keys()]).toEqual(['TELEGRAM_BOT_TOKEN'])
    expect(readFileSync(join(t.root, '.env'), 'utf-8')).toContain('Using the Claude subscription')
  })

  it('serves nothing outside /setup', async () => {
    const t = await boot('local')
    expect((await t.req('/voice')).status).toBe(404)
    expect((await t.req('/setup.html')).status).toBe(404)
  })
})
