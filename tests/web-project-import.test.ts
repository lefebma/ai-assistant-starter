/** Card #280: project import routes. */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-web-project-import-${process.pid}`
})
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4243',
}))

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFileRootsForTest } from '../src/web/files.js'
import { buildZip } from './zip-fixture.js'
import { setZipLimitsForTest } from '../src/projects/claude-export.js'
import { IMPORT_TMP_DIR } from '../src/projects/import.js'

let port = 0
let server: typeof import('../src/http-server.js')
let cookie = ''
let tmp = ''

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  tmp = mkdtempSync(join(tmpdir(), 'web-project-import-'))
  setFileRootsForTest({ root: tmp, uploadsDir: join(tmp, 'uploads') })
  const sessions = await import('../src/web/sessions.js')
  server = await import('../src/http-server.js')
  port = 5700 + Math.floor(Math.random() * 20)
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
  const { token } = sessions.mintWebLink('4243')
  cookie = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
})
afterAll(async () => {
  await server.stopHttpServer()
  setFileRootsForTest(null)
  setZipLimitsForTest()
  rmSync(tmp, { recursive: true, force: true })
})

const url = (p = '') => `http://127.0.0.1:${port}/api/web/projects/import${p}`
const upload = (body: string | Buffer, ct = 'application/octet-stream') =>
  fetch(url(), { method: 'POST', headers: { Cookie: cookie, 'X-Havn-Web': '1', 'Content-Type': ct }, body })
const json = (p: string, body: unknown, ck = cookie) =>
  fetch(url(p), { method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const project = (uuid: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  uuid, name: `Project ${uuid}`, description: `About ${uuid}`, prompt_template: 'Be helpful.', is_starter_project: false,
  docs: [{ uuid: `d-${uuid}`, filename: 'notes.md', content: 'hello', created_at: '2026-01-01T00:00:00Z' }], ...extra,
})
const zip = (...ids: string[]) => buildZip(ids.map((id) => ({ name: `projects/${id}.json`, data: project(id) })))
const tmpFiles = (): string[] => { try { return readdirSync(IMPORT_TMP_DIR) } catch { return [] } }

describe('project import routes', () => {
  it('previews, imports and removes the temp file', async () => {
    const r = await upload(zip('aaa', 'bbb'))
    expect(r.status).toBe(200)
    const pv = (await r.json()) as { importId: string; rows: { uuid: string; status: string }[]; unreadable: number }
    expect(pv.rows.map((x) => [x.uuid, x.status])).toEqual([['aaa', 'new'], ['bbb', 'new']])
    expect(pv.unreadable).toBe(0)
    const done = await json(`/${pv.importId}`, { uuids: ['aaa'] })
    expect(done.status).toBe(200)
    const out = (await done.json()) as { rows: { uuid: string; status: string; projectId?: string }[] }
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({ uuid: 'aaa', status: 'created' })
    expect(tmpFiles()).toEqual([])
    // spent
    expect((await json(`/${pv.importId}`, { uuids: ['bbb'] })).status).toBe(410)
  })

  it('answers manifest for the download-links JSON and leaves no temp file', async () => {
    const r = await upload(JSON.stringify({ data_files: [{ category: 'projects', url: 'https://example.invalid/p.zip' }] }))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'manifest' })
    expect(tmpFiles()).toEqual([])
  })

  it('answers not_projects and corrupt with 400', async () => {
    const np = await upload(buildZip([{ name: 'conversations.json', data: '[]' }]))
    expect(np.status).toBe(400)
    expect(await np.json()).toEqual({ error: 'not_projects' })
    const bad = await upload('this is not a zip at all')
    expect(bad.status).toBe(400)
    expect(tmpFiles()).toEqual([])
  })

  it('answers 413 too_large when the zip passes the upload cap but breaks a parser limit', async () => {
    setZipLimitsForTest({ entries: 1 })
    const r = await upload(zip('a', 'b'))
    setZipLimitsForTest()
    expect(r.status).toBe(413)
    expect(await r.json()).toEqual({ error: 'too_large' })
    expect(tmpFiles()).toEqual([])
  })

  it('refuses a declared length over the cap and a wrong media type', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/web/projects/import', method: 'POST',
          headers: { Cookie: cookie, 'X-Havn-Web': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': String(101 * 1024 * 1024) } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy() },
      )
      req.on('error', (e) => { if (!req.destroyed) reject(e) })
      req.flushHeaders()
    })
    expect(status).toBe(413)
    const t = await upload(zip('a'), 'application/json')
    expect(t.status).toBe(415)
    expect(tmpFiles()).toEqual([])
  })

  it('answers 410 for an import id from another chat and for an unknown id', async () => {
    const sessions = await import('../src/web/sessions.js')
    const db = await import('../src/db.js')
    db.addAuthorizedChat('999', 'other', '4243')
    const pv = (await (await upload(zip('ccc'))).json()) as { importId: string }
    // Another chat: authorize it by minting its own session.
    const { token } = sessions.mintWebLink('999')
    const other = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
    const cross = await json(`/${pv.importId}`, { uuids: ['ccc'] }, other)
    expect(cross.status).toBe(410)
    expect((await json('/00000000-0000-0000-0000-000000000000', { uuids: [] })).status).toBe(410)
    // The owner can still run it: the other chat did not spend it.
    expect((await json(`/${pv.importId}`, { uuids: ['ccc'] })).status).toBe(200)
  })

  it('answers 400 bad_request when uuids is not a string array', async () => {
    const pv = (await (await upload(zip('ddd'))).json()) as { importId: string }
    for (const body of [{}, { uuids: 'ddd' }, { uuids: [1] }, { uuids: null }]) {
      const r = await json(`/${pv.importId}`, body)
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: 'bad_request' })
    }
    // still importable afterwards
    expect((await json(`/${pv.importId}`, { uuids: ['ddd'] })).status).toBe(200)
  })

  it('cancels an import and removes its file', async () => {
    const pv = (await (await upload(zip('eee'))).json()) as { importId: string }
    expect(tmpFiles().length).toBe(1)
    const c = await fetch(url(`/${pv.importId}/cancel`), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
    expect(c.status).toBe(200)
    expect(await c.json()).toEqual({ ok: true })
    expect(tmpFiles()).toEqual([])
    expect((await json(`/${pv.importId}`, { uuids: ['eee'] })).status).toBe(410)
  })
})
