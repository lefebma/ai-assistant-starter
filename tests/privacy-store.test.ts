/**
 * The anonymizer's list, switch, /private command, local proxy and run
 * wiring (card #187).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
  })

  it('never tells another chat what a placeholder or a stored name holds', () => {
    const e = store.addEntry('company', 'Initech Corporation', ['Initech', 'INTC'])
    const asPlaceholder = command.privacyCommand(OTHER, `add COMPANY_${e.id}`)
    expect(asPlaceholder).not.toMatch(/Initech/)
    const again = command.privacyCommand(OTHER, 'add Initech, Initrode')
    expect(again).not.toMatch(/Corporation|INTC|COMPANY_/)
    // The same reply whether or not the name was on the list.
    const fresh = command.privacyCommand(OTHER, 'add Globex, Initrode')
    expect(again.replace('Initech', 'X')).toBe(fresh.replace('Globex', 'X'))
  })

  it('says the filter is off when adding in a chat where it is off', () => {
    expect(command.privacyCommand(OTHER, 'add Globex')).toMatch(/^Noted: Globex will stay.*\/private on turns it on/)
    expect(command.privacyCommand(MAIN, 'add Initrode')).toMatch(/\/private on turns it on/)
  })

  it('shows and shrinks the list in the main chat only', () => {
    command.privacyCommand(OTHER, 'add Globex')
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

  it('refuses a request it cannot mask instead of sending it', async () => {
    const route = await proxy.openRoute(upstreamUrl)
    const res = await fetch(`${route.baseUrl}/v1/messages`, { method: 'POST', body: 'not json Initech' })
    expect(res.status).toBe(400)
    expect(received).toHaveLength(0)
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

  it('treats a model on this machine or network as local', () => {
    expect(privacy.isLocalUrl('http://localhost:11434/v1')).toBe(true)
    expect(privacy.isLocalUrl('http://192.168.1.20:1234/v1')).toBe(true)
    expect(privacy.isLocalUrl('http://[::1]:8080')).toBe(true)
    expect(privacy.isLocalUrl('https://api.together.xyz/v1')).toBe(false)
    expect(privacy.localModelHost('openai', (k) => ({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:1234/v1' } as Record<string, string>)[k])).toBe(true)
    expect(privacy.localModelHost('anthropic', () => undefined)).toBe(false)
  })
})
