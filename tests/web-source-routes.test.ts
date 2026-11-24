/**
 * Card #284: the files panel's Drive routes. Main chat only; any other
 * signed-in chat gets the same 404 as a route that does not exist.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-src-store-'))
  return { resetDrive: { calls: 0 }, root: mkdtempSync(join(tmpdir(), 'web-src-root-')), flow: { current: null as null | { startLink(chat: string, p: string): string } }, streams: [] as import('node:fs').ReadStream[] }
})

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
  PROJECT_ROOT: h.root,
}))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      h.streams.push(stream)
      return stream
    }) as typeof actual.createReadStream,
  }
})
vi.mock('../src/web/drive.js', async (orig) => ({
  ...(await orig<typeof import('../src/web/drive.js')>()),
  resetDriveAccounts: () => void h.resetDrive.calls++,
}))
vi.mock('../src/connect/instance.js', async (orig) => ({
  ...(await orig<typeof import('../src/connect/instance.js')>()),
  getConnectFlow: () => h.flow.current,
}))

import type { DriveDeps } from '../src/web/drive.js'

let port = 0
let server: typeof import('../src/http-server.js')
let routes: typeof import('../src/web/source-routes.js')
let logger: typeof import('../src/logger.js').logger
const cookies: Record<string, string> = {}
const TMP = mkdtempSync(join(tmpdir(), 'web-src-drive-'))

const GOOGLE_DOC = { id: 'abc', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-01T00:00:00Z' }
let behaviour: { code: number; getRow: Record<string, unknown>; ls: unknown; payload: Buffer } = fresh()
function fresh() {
  return { code: 0, getRow: GOOGLE_DOC as Record<string, unknown>, ls: { files: [GOOGLE_DOC], nextPageToken: 'tok2' } as unknown, payload: Buffer.from('%PDF-fake') }
}

function makeDeps(over: Partial<DriveDeps> = {}): DriveDeps {
  return {
    async run(args) {
      if (behaviour.code !== 0) return { code: behaviour.code, stdout: '' }
      const cmd = args[1]
      if (cmd === 'ls') return { code: 0, stdout: JSON.stringify(behaviour.ls) }
      if (cmd === 'get') return { code: 0, stdout: JSON.stringify(behaviour.getRow) }
      const out = args[args.indexOf('--out') + 1]!
      writeFileSync(out, behaviour.payload)
      return { code: 0, stdout: '{}' }
    },
    keeper: null,
    relayConfigured: false,
    gogInstalled: () => true,
    gogAuthList: async () => 'EMAIL\tCLIENT\tSERVICES\nm@x.com\tdefault\tgmail,drive',
    tmpDir: TMP,
    now: () => Date.now(),
    ...over,
  }
}

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  db.addAuthorizedChat('777', 'second person', '4242')
  const sessions = await import('../src/web/sessions.js')
  server = await import('../src/http-server.js')
  routes = await import('../src/web/source-routes.js')
  logger = (await import('../src/logger.js')).logger
  port = 5700 + Math.floor(Math.random() * 25)
  server.startHttpServer(port)
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready__`)
      break
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  for (const chat of ['4242', '777']) {
    const { token } = sessions.mintWebLink(chat)
    cookies[chat] = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
  }
})

afterAll(async () => {
  routes.setDriveDepsForTests(null)
  await server.stopHttpServer()
})

afterEach(() => {
  behaviour = fresh()
  h.flow.current = null
  routes.setDriveDepsForTests(makeDeps())
  vi.restoreAllMocks()
})

const base = () => `http://127.0.0.1:${port}`
const get = (path: string, chat: string | null) =>
  fetch(base() + path, { headers: chat ? { Cookie: cookies[chat]! } : {} })
const post = (path: string, chat: string, contentType = 'application/json') =>
  fetch(base() + path, { method: 'POST', headers: { Cookie: cookies[chat]!, 'Content-Type': contentType }, body: '{}' })

describe('sources', () => {
  it('needs a session', async () => {
    expect((await get('/api/web/sources', null)).status).toBe(401)
  })

  it('a second chat sees no Drive at all', async () => {
    routes.setDriveDepsForTests(makeDeps())
    for (const p of ['/api/web/sources/drive/list?account=m@x.com', '/api/web/sources/drive/raw?account=m@x.com&id=abc']) {
      expect((await get(p, '777')).status).toBe(404)
    }
    expect((await post('/api/web/sources/drive/connect', '777')).status).toBe(404)
    expect(await (await get('/api/web/sources', '777')).json()).toEqual({
      sources: [{ id: 'local', name: 'Havn files' }],
      canConnectDrive: false,
      connect: null,
    })
  })

  it('the main chat sees its Drive accounts and their state', async () => {
    routes.setDriveDepsForTests(makeDeps({
      relayConfigured: true,
      keeper: { accounts: async () => [{ account: 'm@x.com', state: 'ok' }, { account: 'old@x.com', state: 'reconnect' }], token: async () => 't' },
    }))
    const body = await (await get('/api/web/sources', '4242')).json()
    expect(body).toEqual({
      sources: [
        { id: 'local', name: 'Havn files' },
        { id: 'drive:m@x.com', name: 'Google Drive', account: 'm@x.com', state: 'ok' },
        { id: 'drive:old@x.com', name: 'Google Drive', account: 'old@x.com', state: 'reconnect' },
      ],
      canConnectDrive: true,
      connect: 'relay',
    })
  })

  it('a box with no way to connect Drive says so', async () => {
    routes.setDriveDepsForTests(makeDeps({ gogInstalled: () => false }))
    expect(await (await get('/api/web/sources', '4242')).json()).toEqual({
      sources: [{ id: 'local', name: 'Havn files' }],
      canConnectDrive: false,
      connect: null,
    })
  })
})

describe('list', () => {
  it('lists a folder with a kind on every entry', async () => {
    behaviour.ls = { files: [GOOGLE_DOC, { id: 'f1', name: 'Dir', mimeType: 'application/vnd.google-apps.folder' }], nextPageToken: 'tok2' }
    const r = await get('/api/web/sources/drive/list?account=m@x.com', '4242')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { entries: { id: string; kind: string; isDir: boolean }[]; nextPage: string | null }
    expect(body.nextPage).toBe('tok2')
    expect(body.entries.find((e) => e.id === 'abc')!.kind).toBe('pdf')
    expect(body.entries.find((e) => e.id === 'f1')).toMatchObject({ isDir: true, kind: 'other' })
  })
})

describe('failures', () => {
  it.each([
    ['reconnect', 409],
    ['not_connected', 409],
    ['not_found', 404],
    ['too_large', 413],
    ['unavailable', 503],
  ] as const)('a %s failure answers %i with the code', async (code, status) => {
    let account = 'm@x.com'
    if (code === 'reconnect') behaviour.code = 4
    if (code === 'not_found') behaviour.code = 5
    if (code === 'unavailable') behaviour.code = 1
    if (code === 'not_connected') account = 'nobody@x.com'
    if (code === 'too_large') behaviour.getRow = { id: 'abc', name: 'Big', mimeType: 'video/mp4', size: String(26 * 1024 * 1024) }
    for (const p of [`/api/web/sources/drive/raw?account=${account}&id=abc`, `/api/web/sources/drive/list?account=${account}`]) {
      if (code === 'too_large' && p.includes('/list')) continue
      const r = await get(p, '4242')
      expect(r.status).toBe(status)
      expect(await r.json()).toEqual({ error: code })
    }
  })

  it('a missing id is not found', async () => {
    expect((await get('/api/web/sources/drive/raw?account=m@x.com', '4242')).status).toBe(404)
  })
})

const settle = async (cond: () => boolean) => {
  const end = Date.now() + 3000
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

describe('raw', () => {
  it('serves a Google Doc as an inline PDF framed by our page only, then deletes the temp file', async () => {
    const res = await get('/api/web/sources/drive/raw?account=m@x.com&id=abc', '4242')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('inline')
    expect(res.headers.get('content-disposition')).toContain('Doc.pdf')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-fake')
    await settle(() => readdirSync(TMP).length === 0)
    expect(readdirSync(TMP)).toEqual([])
  })

  it('answers 404 for a Google type that cannot be previewed', async () => {
    behaviour.getRow = { id: 'abc', name: 'Form', mimeType: 'application/vnd.google-apps.form' }
    expect((await get('/api/web/sources/drive/raw?account=m@x.com&id=abc', '4242')).status).toBe(404)
  })

  it('deletes the temp file and closes the read stream when the browser goes away mid-download', async () => {
    const size = 24 * 1024 * 1024
    behaviour.getRow = { id: 'abc', name: 'Big.bin', mimeType: 'application/octet-stream', size: String(size) }
    behaviour.payload = Buffer.alloc(size, 1)
    h.streams.length = 0
    // A raw client that takes the first chunk and then hangs up, so the 24 MB can never all be written.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        base() + '/api/web/sources/drive/raw?account=m@x.com&id=abc',
        { headers: { Cookie: cookies['4242']! } },
        (res) => {
          res.once('data', () => {
            expect(readdirSync(TMP).length).toBe(1)
            res.destroy()
            resolve()
          })
        },
      )
      req.on('error', () => {})
      setTimeout(() => reject(new Error('no data')), 5000)
    })
    await settle(() => readdirSync(TMP).length === 0 && h.streams.length === 1 && h.streams[0]!.destroyed)
    expect(readdirSync(TMP)).toEqual([])
    expect(h.streams).toHaveLength(1)
    expect(h.streams[0]!.destroyed).toBe(true)
  })
})

describe('connect', () => {
  it('returns a one-time link for provider drive on a relay box', async () => {
    h.flow.current = { startLink: (chat, p) => `https://relay.example/start?provider=${p}&nonce=${chat}n` }
    routes.setDriveDepsForTests(makeDeps({ relayConfigured: true, keeper: { accounts: async () => [], token: async () => null } }))
    const r = await post('/api/web/sources/drive/connect', '4242')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { url: string }
    expect(new URL(body.url).searchParams.get('provider')).toBe('drive')
    expect(new URL(body.url).searchParams.get('nonce')).toBe('4242n')
  })

  it('answers 503 on a relay box with no connect flow', async () => {
    routes.setDriveDepsForTests(makeDeps({ relayConfigured: true }))
    const r = await post('/api/web/sources/drive/connect', '4242')
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'unavailable' })
  })

  it('returns the command to run on a gog box, and forgets the cached gog accounts', async () => {
    h.resetDrive.calls = 0
    const r = await post('/api/web/sources/drive/connect', '4242')
    expect(r.status).toBe(200)
    expect(h.resetDrive.calls).toBe(1)
    expect(await r.json()).toEqual({
      command:
        'gog auth add <your Gmail address> --services gmail,calendar,drive --drive-scope readonly --gmail-scope send --extra-scopes https://www.googleapis.com/auth/gmail.modify',
    })
  })

  it('answers 404 when this box cannot connect Drive', async () => {
    routes.setDriveDepsForTests(makeDeps({ gogInstalled: () => false }))
    expect((await post('/api/web/sources/drive/connect', '4242')).status).toBe(404)
  })

  it('needs the JSON content type', async () => {
    const r = await post('/api/web/sources/drive/connect', '4242', 'application/x-www-form-urlencoded')
    expect(r.status).toBe(415)
  })
})

describe('logging', () => {
  it('logs counts, never ids, names or accounts', async () => {
    const spies = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error'), vi.spyOn(logger, 'debug')]
    await get('/api/web/sources', '4242')
    await get('/api/web/sources/drive/list?account=m@x.com', '4242')
    const r = await get('/api/web/sources/drive/raw?account=m@x.com&id=abc', '4242')
    await r.arrayBuffer()
    behaviour.code = 1
    await get('/api/web/sources/drive/raw?account=m@x.com&id=abc', '4242')
    const text = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(text).toContain('drive')
    // The failure is logged too, with the exit code only.
    expect(text).toContain('{"event":"drive get","ok":false,"exit":1}')
    for (const secret of ['abc', 'Doc', 'm@x.com']) expect(text).not.toContain(secret)
  })

  it('warns with a count-only line when the account check fails, and still answers', async () => {
    const warn = vi.spyOn(logger, 'warn')
    routes.setDriveDepsForTests(makeDeps({ relayConfigured: true, keeper: { accounts: async () => { throw new Error('boom m@x.com') }, token: async () => null } }))
    const r = await get('/api/web/sources', '4242')
    expect(r.status).toBe(200)
    const text = JSON.stringify(warn.mock.calls)
    expect(text).toContain('drive sources failed')
    expect(text).not.toContain('m@x.com')
    expect(text).not.toContain('boom')
  })
})
