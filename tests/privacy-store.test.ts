/**
 * The anonymizer's list, switch, /private command, local proxy and run
 * wiring (card #187).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mockReadEnvFile } = vi.hoisted(() => ({ mockReadEnvFile: vi.fn((): Record<string, string> => ({})) }))
vi.mock('../src/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/env.js')>()),
  readEnvFile: mockReadEnvFile,
}))

const STORE = mkdtempSync(join(tmpdir(), 'privacy-store-'))
process.env['AGENT_STORE_DIR'] = STORE

let db: typeof import('../src/db.js')
let store: typeof import('../src/privacy/store.js')
let command: typeof import('../src/privacy/command.js')
let proxy: typeof import('../src/privacy/proxy.js')
let privacy: typeof import('../src/privacy/index.js')
let egress: typeof import('../src/egress/index.js')
let policy: typeof import('../src/egress/policy.js')

beforeAll(async () => {
  db = await import('../src/db.js')
  db.initDatabase()
  store = await import('../src/privacy/store.js')
  command = await import('../src/privacy/command.js')
  proxy = await import('../src/privacy/proxy.js')
  privacy = await import('../src/privacy/index.js')
  egress = await import('../src/egress/index.js')
  policy = await import('../src/egress/policy.js')
})

beforeEach(() => {
  db.getDb().exec("DELETE FROM privacy_names; DELETE FROM app_state WHERE key LIKE 'privacy:%'")
  store.resetPrivacyCache()
  mockReadEnvFile.mockReturnValue({})
  delete process.env.PRIVACY
})

const MAIN = { chatId: 'main', primary: true }
const OTHER = { chatId: 'other', primary: false }

describe('the switch', () => {
  it('is off until a chat turns it on, and then only for that chat', () => {
    expect(store.privacyState('main')).toEqual({ on: false, boxWide: false })
    store.setChatPrivacy('main', true)
    expect(store.privacyState('main').on).toBe(true)
    expect(store.privacyState('other').on).toBe(false)
  })

  it('reads a store that exists on disk even when nothing has opened it yet', async () => {
    store.setChatPrivacy('main', true)
    db.getDb().close()
    expect(db.dbIsOpen()).toBe(false)
    expect(store.privacyState('main').on).toBe(true)
    expect(db.dbIsOpen()).toBe(true)
  })

  it('covers a run with no chat whenever any chat has it on', () => {
    expect(store.privacyState(undefined).on).toBe(false)
    store.setChatPrivacy('other', true)
    expect(store.privacyState(undefined).on).toBe(true)
  })

  it('PRIVACY=on covers every chat, and a chat cannot turn it off', () => {
    mockReadEnvFile.mockReturnValue({ PRIVACY: 'on' })
    expect(store.privacyState('anything')).toEqual({ on: true, boxWide: true })
    expect(command.privacyCommand(OTHER, 'off')).toMatch(/cannot be switched off/)
    expect(store.privacyState('other').on).toBe(true)
  })
})

describe('the list', () => {
  it('finds an email that only appears in earlier thinking, so that block is left out', async () => {
    const anthropic = await import('../src/privacy/anthropic.js')
    const body = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'mail zed@globex.io', signature: 's' }, { type: 'text', text: 'ok' }] }, { role: 'user', content: 'next' }] }
    const scope = store.maskerFor(anthropic.requestTexts(body)).scope()
    const out = anthropic.maskRequest(body, scope) as any
    expect(JSON.stringify(out)).not.toMatch(/zed@globex/)
  })

  it('adds one row for one phone number however it is written', () => {
    store.maskerFor(['call 416-555-0177 or (416) 555-0177'])
    expect(store.listEntries().filter((e) => e.kind === 'phone')).toHaveLength(1)
  })

  it('adds email addresses and phone numbers by itself before they go out', () => {
    const masker = store.maskerFor(['reach me at bo@initech.io or 647 555 0100', 'bo@initech.io again'])
    expect(masker.mask('bo@initech.io, 647-555-0100')).toMatch(/^EMAIL_\d+, PHONE_\d+$/)
    const auto = store.listEntries().filter((e) => e.source === 'auto')
    expect(auto.map((e) => e.kind).sort()).toEqual(['email', 'phone'])
    // Seen again: not added twice.
    store.maskerFor(['BO@INITECH.IO', '(647) 555-0100'])
    expect(store.listEntries().filter((e) => e.source === 'auto')).toHaveLength(2)
  })

  it('keeps a placeholder stable, and never reuses the number of a removed name', () => {
    const a = store.addEntry('company', 'Initech')
    store.removeEntry(a.id)
    const b = store.addEntry('company', 'Globex')
    expect(b.id).toBeGreaterThan(a.id)
    expect(store.currentMasker().mask('Initech and Globex')).toBe(`Initech and COMPANY_${b.id}`)
  })
})

describe('/private', () => {
  it('explains itself and says whether it is on', () => {
    expect(command.privacyCommand(MAIN, '')).toMatch(/Privacy filter: Off for this chat/)
    expect(command.privacyCommand(MAIN, 'on')).toMatch(/on for this chat/)
    expect(command.privacyCommand(MAIN, '')).toMatch(/Privacy filter: On for this chat/)
  })

  it('adds a name with aliases, guessing what kind it is', () => {
    expect(command.privacyCommand(MAIN, 'add Initech Corporation, Initech')).toMatch(/^Added company: Initech Corporation \(also Initech\) as COMPANY_\d+/)
    expect(command.privacyCommand(MAIN, 'add Peter Gibbons')).toMatch(/^Added person: Peter Gibbons as PERSON_\d+/)
    expect(command.privacyCommand(MAIN, 'add person Bolton')).toMatch(/^Added person: Bolton/)
    expect(command.privacyCommand(MAIN, 'add Initech Corporation')).toMatch(/already on the list/)
    expect(command.privacyCommand(MAIN, 'add Initech Corporation, INTC')).toMatch(/^Updated: Initech Corporation \(also Initech, INTC\)/)
    expect(command.privacyCommand(MAIN, 'add Initech Corporation')).toMatch(/already on the list, as COMPANY_\d+/)
    expect(command.privacyCommand(MAIN, 'add Al')).toMatch(/at least 3 characters/)
    expect(command.privacyCommand(MAIN, 'add Jane "JJ" Doe')).toMatch(/cannot contain double quotes/)
  })

  it('lets only the main chat add names, and tells another chat nothing about the list', () => {
    const e = store.addEntry('company', 'Initech Corporation', ['Initech', 'INTC'])
    const before = store.listEntries().length
    for (const arg of [`add COMPANY_${e.id}`, 'add Initech, Initrode', 'add Globex', 'add the']) {
      expect(command.privacyCommand(OTHER, arg)).toBe('Names can only be added in the main chat.')
    }
    expect(store.listEntries()).toHaveLength(before)
  })

  it('says the filter is off when adding in a chat where it is off', () => {
    expect(command.privacyCommand(MAIN, 'add Initrode')).toMatch(/\/private on turns it on/)
  })

  it('shows and shrinks the list in the main chat only', () => {
    command.privacyCommand(MAIN, 'add Globex')
    expect(command.privacyCommand(OTHER, 'list')).toMatch(/only be shown in the main chat/)
    expect(command.privacyCommand(OTHER, 'remove Globex')).toMatch(/only be removed in the main chat/)
    expect(command.privacyCommand(MAIN, 'list')).toMatch(/- Globex as NAME_\d+/)
    expect(command.privacyCommand(MAIN, 'remove globex')).toMatch(/^Removed Globex/)
    expect(command.privacyCommand(MAIN, 'remove Globex')).toMatch(/not on the list/)
  })

  it('removes by placeholder too', () => {
    const e = store.addEntry('person', 'Milton Waddams')
    expect(command.privacyCommand(MAIN, `remove PERSON_${e.id}`)).toMatch(/^Removed Milton Waddams/)
  })

  it('guesses kinds', () => {
    expect(command.guessKind('Acme Inc.')).toBe('company')
    expect(command.guessKind('Jane Smith')).toBe('person')
    expect(command.guessKind('a@b.co')).toBe('email')
    expect(command.guessKind('+1 416 555 0100')).toBe('phone')
    expect(command.guessKind('Project Falcon launch')).toBe('other')
    expect(command.guessKind('falcon')).toBe('other')
  })
})

describe('the local proxy', () => {
  let upstream: Server
  let upstreamUrl = ''
  let received: { path: string; body: string; headers: Record<string, unknown> }[] = []
  let reply: (path: string, res: import('node:http').ServerResponse) => void

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), headers: req.headers })
        reply(req.url ?? '', res)
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await proxy.stopPrivacyProxy()
    await new Promise<void>((r) => upstream.close(() => r()))
  })
  afterEach(() => {
    received = []
  })

  it('masks what goes out and restores a streamed reply', async () => {
    const e = store.addEntry('company', 'Initech')
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`)
      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done for COMP"}}\n\n`)
      res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ANY_${e.id}"}}\n\n`)
      res.end(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`)
    }
    const route = await proxy.openRoute(upstreamUrl)
    const res = await fetch(`${route.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'Invoice Initech, cc pat@initech.com' }], stream: true }),
    })
    const text = await res.text()
    expect(received[0].path).toBe('/v1/messages?beta=true')
    expect(received[0].headers.authorization).toBe('Bearer tok')
    expect(received[0].body).not.toMatch(/initech/i)
    expect(received[0].body).toMatch(new RegExp(`Invoice COMPANY_${e.id}, cc EMAIL_\\d+`))
    const restored = text.split('\n\n').filter((x) => x.includes('text_delta')).map((x) => JSON.parse(x.split('data: ')[1]).delta.text).join('')
    expect(restored).toBe('Done for Initech')
    route.drop()
  })

  it('restores a whole JSON reply', async () => {
    const e = store.addEntry('person', 'Peter Gibbons')
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: `Hi PERSON_${e.id}` }] }))
    }
    const route = await proxy.openRoute(upstreamUrl)
    const res = await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Peter Gibbons' }] }) })
    expect(await res.json()).toEqual({ content: [{ type: 'text', text: 'Hi Peter Gibbons' }] })
    route.drop()
  })

  it('passes other paths through unchanged', async () => {
    store.addEntry('company', 'Initech')
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"name":"Initech"}')
    }
    const route = await proxy.openRoute(upstreamUrl)
    const res = await fetch(`${route.baseUrl}/api/oauth/profile`)
    expect(await res.text()).toBe('{"name":"Initech"}')
    expect(received[0].path).toBe('/api/oauth/profile')
    route.drop()
  })

  it('masks every string in any other JSON request, and refuses one it cannot read', async () => {
    store.addEntry('company', 'Initech')
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    const route = await proxy.openRoute(upstreamUrl)
    await fetch(`${route.baseUrl}/api/event_logging/batch`, { method: 'POST', body: JSON.stringify({ events: [{ note: 'Initech', Initech: 1 }] }) })
    expect(received.at(-1)!.body).not.toMatch(/initech/i)
    const res = await fetch(`${route.baseUrl}/api/upload`, { method: 'POST', body: 'raw Initech bytes' })
    expect(res.status).toBe(403)
    expect(received).toHaveLength(1)
    route.drop()
  })

  it('refuses a request it cannot mask instead of sending it', async () => {
    const route = await proxy.openRoute(upstreamUrl)
    const res = await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: 'not json Initech' })
    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
    route.drop()
  })

  it('stops the upstream call when the CLI goes away', async () => {
    let closed = false
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const t = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 20)
      res.on('close', () => {
        closed = true
        clearInterval(t)
      })
    }
    const route = await proxy.openRoute(upstreamUrl)
    const ac = new AbortController()
    const res = await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [] }), signal: ac.signal })
    const reader = res.body!.getReader()
    await reader.read()
    ac.abort()
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20))
    expect(closed).toBe(true)
    route.drop()
  })

  it('counts the requests a route carried', async () => {
    reply = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    const route = await proxy.openRoute(upstreamUrl)
    expect(route.hits()).toBe(0)
    await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [] }) })
    await fetch(`${route.baseUrl}/api/other`)
    expect(route.hits()).toBe(1)
    route.drop()
  })

  it('refuses an unknown or dropped route', async () => {
    const route = await proxy.openRoute(upstreamUrl)
    route.drop()
    const res = await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    const port = Number(new URL(route.baseUrl).port)
    expect((await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect(received).toHaveLength(0)
  })
})

describe('a private run', () => {
  it('points the CLI at the proxy, forwarding to the base URL it had, and closes the route after', async () => {
    let seen: Record<string, string | undefined> | NodeJS.ProcessEnv | undefined
    await privacy.withPrivacy(true, async () => {
      seen = await privacy.privateCliEnv({ ANTHROPIC_BASE_URL: 'https://gateway.example', X: '1' })
    })
    expect(seen?.X).toBe('1')
    expect(seen?.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[\w-]+$/)
    const res = await fetch(`${seen!.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  it('refuses a private turn that Claude Code would send around the relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-bypass-'))
    const home = mkdtempSync(join(tmpdir(), 'privacy-home-'))
    expect(privacy.relayBypass({}, dir, home)).toBeNull()
    expect(privacy.relayBypass({ CLAUDE_CODE_USE_BEDROCK: '1' }, dir, home)).toMatch(/CLAUDE_CODE_USE_BEDROCK is set/)
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }))
    expect(privacy.relayBypass({}, dir, home)).toMatch(/sets ANTHROPIC_BASE_URL/)
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json')
    expect(privacy.relayBypass({}, dir, home)).toMatch(/could not be read/)
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { OTHER: '1' } }))
    expect(privacy.relayBypass({}, dir, home)).toBeNull()
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.example' } }))
    await expect(privacy.withPrivacy(true, () => privacy.privateCliEnv({}, dir))).rejects.toThrow(/The turn was not sent/)
  })

  it('treats a switch it cannot read as on, but a store never set up as off', () => {
    expect(privacy.privacyOnFor('main', () => { throw new Error('disk I/O error') })).toBe(true)
    expect(privacy.privacyOnFor('main', () => { throw new Error('SqliteError: no such table: app_state') })).toBe(false)
  })

  it('gives a voice call a notice instead of an answer while the chat is private', async () => {
    const { createAssistantBackend } = await import('../src/voice-live.js')
    store.setChatPrivacy('main', true)
    expect(await createAssistantBackend('main')('who is my client?', new AbortController().signal)).toBe(privacy.PRIVATE_VOICE_NOTICE)
  })

  it('changes nothing outside a private run', async () => {
    const env = { A: '1' }
    expect(await privacy.privateCliEnv(env)).toBe(env)
    expect(await privacy.privateCliEnv(undefined)).toBeUndefined()
    await privacy.withPrivacy(false, async () => {
      expect(privacy.privacyActive()).toBe(false)
    })
  })

  it('lets the CLI reach the proxy when egress is enforced, at its exact address only', () => {
    const base: import('../src/egress/policy.js').EgressPolicy = { name: 'chat', write: [], read: [] }
    const p = egress.withPrivacyProxy(base, '127.0.0.1:45555')
    expect(policy.decide(p, { host: '127.0.0.1', port: 45555, method: 'POST' })).toEqual({ allow: true, via: 'write' })
    expect(policy.decide(p, { host: '127.0.0.1', port: 45556, method: 'POST' }).allow).toBe(false)
    expect(egress.withPrivacyProxy(base, null)).toBe(base)
  })

  it('in a private turn, takes the AI host off the list so only the relay reaches it', () => {
    const chat: import('../src/egress/policy.js').EgressPolicy = { name: 'chat', write: [{ host: 'api.anthropic.com', wildcard: false }, { host: 'gmail.googleapis.com', wildcard: false }], read: [] }
    const p = egress.withPrivacyProxy(chat, '127.0.0.1:45555', true)
    expect(policy.decide(p, { host: 'api.anthropic.com', port: 443, method: null }).allow).toBe(false)
    expect(policy.decide(p, { host: 'gmail.googleapis.com', port: 443, method: null }).allow).toBe(true)
    expect(policy.decide(p, { host: '127.0.0.1', port: 45555, method: 'POST' }).allow).toBe(true)
    expect(policy.decide(egress.withPrivacyProxy(chat, '127.0.0.1:45555', false), { host: 'api.anthropic.com', port: 443, method: null }).allow).toBe(true)
    // A wildcard, or the read list (which still opens a tunnel), does not get around it.
    const loose: import('../src/egress/policy.js').EgressPolicy = { name: 'role', write: [{ host: 'anthropic.com', wildcard: true }], read: [{ host: 'api.anthropic.com', wildcard: false }, { host: 'example.com', wildcard: false }] }
    const q = egress.withPrivacyProxy(loose, '127.0.0.1:45555', true)
    expect(policy.decide(q, { host: 'api.anthropic.com', port: 443, method: null }).allow).toBe(false)
    expect(policy.decide(q, { host: 'example.com', port: 443, method: null }).allow).toBe(true)
  })

  it('treats a model on this machine or network as local', () => {
    expect(privacy.isLocalUrl('http://localhost:11434/v1')).toBe(true)
    expect(privacy.isLocalUrl('http://192.168.1.20:1234/v1')).toBe(true)
    expect(privacy.isLocalUrl('http://[::1]:8080')).toBe(true)
    expect(privacy.isLocalUrl('https://api.together.xyz/v1')).toBe(false)
    expect(privacy.localModelHost('openai', (k) => ({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:1234/v1' } as Record<string, string>)[k])).toBe(true)
    expect(privacy.localModelHost('anthropic', () => undefined)).toBe(false)
  })
})
