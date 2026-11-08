/** Card #280: project file routes. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-web-project-files-${process.pid}`
})
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4243',
}))

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFileRootsForTest } from '../src/web/files.js'
import { projectFilesDir, setProjectFileLimitsForTest } from '../src/projects/files.js'

let port = 0
let server: typeof import('../src/http-server.js')
let cookie = ''
let tmp = ''
let pid = ''
let otherPid = ''

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  tmp = mkdtempSync(join(tmpdir(), 'web-project-files-'))
  setFileRootsForTest({ root: tmp, uploadsDir: join(tmp, 'uploads') })
  const sessions = await import('../src/web/sessions.js')
  const store = await import('../src/projects/store.js')
  server = await import('../src/http-server.js')
  const mine = store.createProject('4243', 'Mine')
  const theirs = store.createProject('999', 'Theirs')
  if ('error' in mine || 'error' in theirs) throw new Error('setup')
  pid = mine.project.id
  otherPid = theirs.project.id
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
beforeEach(() => setProjectFileLimitsForTest())
afterAll(async () => {
  await server.stopHttpServer()
  setFileRootsForTest(null)
  setProjectFileLimitsForTest()
  rmSync(tmp, { recursive: true, force: true })
})

const url = (p: string) => `http://127.0.0.1:${port}/api/web/projects/${p}`
const post = (id: string, name: string, body: string | Buffer, ct = 'application/octet-stream') =>
  fetch(url(`${id}/files?name=${encodeURIComponent(name)}`), {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Havn-Web': '1', 'Content-Type': ct },
    body,
  })
const del = (id: string, name: string) =>
  fetch(url(`${id}/files/delete`), {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
const list = (id: string) => fetch(url(`${id}/files`), { headers: { Cookie: cookie } })

describe('project file routes', () => {
  it('uploads, lists, downloads and deletes', async () => {
    const r = await post(pid, 'brief.txt', 'hello')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ file: { name: 'brief.txt', size: 5 } })
    expect(await (await list(pid)).json()).toEqual({ files: [{ name: 'brief.txt', size: 5 }] })

    const d = await fetch(url(`${pid}/files/brief.txt`), { headers: { Cookie: cookie } })
    expect(d.status).toBe(200)
    expect(await d.text()).toBe('hello')
    expect(d.headers.get('content-disposition')).toBe('attachment; filename="brief.txt"')
    expect(d.headers.get('x-content-type-options')).toBe('nosniff')

    expect((await del(pid, 'brief.txt')).status).toBe(200)
    expect((await del(pid, 'brief.txt')).status).toBe(404)
    expect(await (await list(pid)).json()).toEqual({ files: [] })
    expect(readdirSync(projectFilesDir(pid))).toEqual([])
  })

  it('answers 404 for another chat project on all four routes', async () => {
    expect((await list(otherPid)).status).toBe(404)
    expect((await post(otherPid, 'a.txt', 'x')).status).toBe(404)
    expect((await del(otherPid, 'a.txt')).status).toBe(404)
    expect((await fetch(url(`${otherPid}/files/a.txt`), { headers: { Cookie: cookie } })).status).toBe(404)
    expect(existsSync(projectFilesDir(otherPid))).toBe(false)
  })

  it('keeps a traversal name inside the project folder', async () => {
    const r = await post(pid, '../../escape.txt', 'x')
    expect(r.status).toBe(200)
    const { file } = (await r.json()) as { file: { name: string } }
    expect(file.name).not.toContain('/')
    expect(readdirSync(projectFilesDir(pid))).toEqual([file.name])
    expect(existsSync(join(tmp, 'escape.txt'))).toBe(false)
    const g = await fetch(url(`${pid}/files/..%2F..%2Fescape.txt`), { headers: { Cookie: cookie } })
    expect(g.status).toBe(404)
    await del(pid, file.name)
  })

  it('maps errors and leaves no .part behind', async () => {
    expect((await post(pid, 'a.txt', 'x', 'text/plain')).status).toBe(415)
    expect((await post(pid, '', 'x')).status).toBe(400)
    expect((await post(pid, 'x.part', 'x')).status).toBe(400)

    setProjectFileLimitsForTest({ fileBytes: 3 })
    const big = await post(pid, 'big.txt', 'toolong')
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ error: 'too_large' })

    setProjectFileLimitsForTest({ files: 1 })
    expect((await post(pid, 'one.txt', 'x')).status).toBe(200)
    const many = await post(pid, 'two.txt', 'x')
    expect(many.status).toBe(409)
    expect(await many.json()).toEqual({ error: 'too_many' })

    setProjectFileLimitsForTest({ bytes: 2 })
    const full = await post(pid, 'three.txt', 'xx')
    expect(full.status).toBe(409)
    expect(await full.json()).toEqual({ error: 'project_full' })

    expect(readdirSync(projectFilesDir(pid))).toEqual(['one.txt'])
    await del(pid, 'one.txt')
  })
})
