/** Import from ChatGPT (Feature #282): the upload and import routes. */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.hoisted(() => {
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-web-chatgpt-import-${process.pid}`
})
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4244',
}))

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFileRootsForTest } from '../src/web/files.js'
import { IMPORT_TMP_DIR } from '../src/projects/import.js'
import { MAX_INSTRUCTIONS } from '../src/projects/store.js'
import { conversation, day } from './chatgpt-fixture.js'

let port = 0
let server: typeof import('../src/http-server.js')
let store: typeof import('../src/projects/store.js')
const cookies: Record<string, string> = {}
let tmp = ''

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  db.addAuthorizedChat('999', 'someone else', '4244')
  tmp = mkdtempSync(join(tmpdir(), 'web-chatgpt-import-'))
  setFileRootsForTest({ root: tmp, uploadsDir: join(tmp, 'uploads') })
  const sessions = await import('../src/web/sessions.js')
  store = await import('../src/projects/store.js')
  server = await import('../src/http-server.js')
  port = 5730 + Math.floor(Math.random() * 20)
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
  for (const chat of ['4244', '999']) {
    const { token } = sessions.mintWebLink(chat)
    cookies[chat] = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
  }
})
afterAll(async () => {
  await server.stopHttpServer()
  setFileRootsForTest(null)
  rmSync(tmp, { recursive: true, force: true })
})

const url = (p = '') => `http://127.0.0.1:${port}/api/web/projects/chatgpt-import${p}`
const upload = (body: unknown, chat = '4244') =>
  fetch(url(), {
    method: 'POST',
    headers: { Cookie: cookies[chat]!, 'X-Havn-Web': '1', 'Content-Type': 'application/octet-stream' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const run = (id: string, projects: unknown, chat = '4244') =>
  fetch(url(`/${id}`), { method: 'POST', headers: { Cookie: cookies[chat]!, 'Content-Type': 'application/json' }, body: JSON.stringify({ projects }) })
const tmpFiles = (): string[] => {
  try {
    return readdirSync(IMPORT_TMP_DIR)
  } catch {
    return []
  }
}
const filesOf = (projectId: string): string[] => {
  try {
    return readdirSync(join(tmp, 'uploads', 'projects', projectId)).sort()
  } catch {
    return []
  }
}

interface Preview {
  importId: string
  rows: Array<{ id: string; name: string; conversations: number; from: string; to: string; titles: string[]; fileNames: string[]; status: string }>
  unreadable: number
}

const exportOf = (project: string, ...ids: string[]) =>
  ids.map((id, i) =>
    conversation({ id: `${project}-${id}`, project, title: `Talk ${id}`, created: day(`2025-0${i + 1}-10`), messages: [{ role: 'user', text: `question ${id}` }, { role: 'assistant', text: `answer ${id}` }] })
  )

describe('ChatGPT import routes', () => {
  it('previews projects, then imports one with its name, instructions and history, and leaves no temp file', async () => {
    const r = await upload([...exportOf('g-p-one', 'a', 'b'), ...exportOf('g-p-two', 'c'), conversation({ id: 'loose', project: null, messages: [] })])
    expect(r.status).toBe(200)
    const pv = (await r.json()) as Preview
    expect(tmpFiles()).toEqual([])
    expect(pv.rows.map((x) => [x.id, x.conversations, x.status])).toEqual([
      ['g-p-one', 2, 'new'],
      ['g-p-two', 1, 'new'],
    ])
    expect(pv.rows[0]).toMatchObject({ name: 'ChatGPT project 1', from: '2025-01-10', to: '2025-02-10', titles: ['Talk b', 'Talk a'] })
    expect(pv.rows[0]!.fileNames).toEqual(['ChatGPT 2025-01-10 Talk a.md', 'ChatGPT 2025-02-10 Talk b.md'])

    const done = await run(pv.importId, [{ id: 'g-p-one', name: 'Acme rollout', instructions: 'Keep answers short.' }])
    expect(done.status).toBe(200)
    const out = (await done.json()) as { rows: Array<{ uuid: string; name: string; status: string; projectId: string; leftOut: string[] }> }
    expect(out.rows).toEqual([expect.objectContaining({ uuid: 'g-p-one', name: 'Acme rollout', status: 'created', leftOut: [] })])
    const p = store.getProject('4244', out.rows[0]!.projectId)!
    expect(p).toMatchObject({ name: 'Acme rollout', instructions: 'Keep answers short.', source: 'chatgpt:g-p-one' })
    expect(filesOf(p.id)).toEqual(['ChatGPT 2025-01-10 Talk a.md', 'ChatGPT 2025-02-10 Talk b.md'])
    const text = readFileSync(join(tmp, 'uploads', 'projects', p.id, 'ChatGPT 2025-01-10 Talk a.md'), 'utf8')
    expect(text).toContain('**You:**\n\nquestion a')
    expect(text).toContain('**ChatGPT:**\n\nanswer a')
    // spent
    expect((await run(pv.importId, [{ id: 'g-p-two', name: 'x' }])).status).toBe(410)
  })

  it('shows an imported project as already here and skips it, and adds (ChatGPT) on a name clash', async () => {
    const pv = (await (await upload([...exportOf('g-p-one', 'a'), ...exportOf('g-p-three', 'd')])).json()) as Preview
    expect(pv.rows.find((x) => x.id === 'g-p-one')!.status).toBe('already')
    const out = (await (await run(pv.importId, [
      { id: 'g-p-one', name: 'Again' },
      { id: 'g-p-three', name: 'Acme rollout' },
    ])).json()) as { rows: Array<{ uuid: string; name: string; status: string }> }
    expect(out.rows.map((x) => [x.uuid, x.status, x.name])).toEqual([
      ['g-p-one', 'skipped', 'Again'],
      ['g-p-three', 'created', 'Acme rollout (ChatGPT)'],
    ])
  })

  it('keeps instructions over the limit as a file and says so', async () => {
    const pv = (await (await upload(exportOf('g-p-long', 'a'))).json()) as Preview
    const long = 'line\n'.repeat(MAX_INSTRUCTIONS / 2)
    const out = (await (await run(pv.importId, [{ id: 'g-p-long', name: 'Long one', instructions: long }])).json()) as {
      rows: Array<{ status: string; reason?: string; projectId: string }>
    }
    expect(out.rows[0]).toMatchObject({ status: 'created' })
    expect(out.rows[0]!.reason).toMatch(/Full instructions\.md/)
    expect(store.getProject('4244', out.rows[0]!.projectId)!.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
    expect(filesOf(out.rows[0]!.projectId)).toContain('Full instructions.md')
  })

  it("never lets another chat run or see someone's import", async () => {
    const pv = (await (await upload(exportOf('g-p-mine', 'a'))).json()) as Preview
    expect((await run(pv.importId, [{ id: 'g-p-mine', name: 'Theirs now' }], '999')).status).toBe(410)
    // Still there for its owner.
    expect((await run(pv.importId, [{ id: 'g-p-mine', name: 'Mine' }])).status).toBe(200)
  })

  it('refuses a project picked twice in one request', async () => {
    const pv = (await (await upload(exportOf('g-p-twice', 'a'))).json()) as Preview
    const out = (await (await run(pv.importId, [
      { id: 'g-p-twice', name: 'One' },
      { id: 'g-p-twice', name: 'Two' },
    ])).json()) as { rows: Array<{ status: string; reason?: string }> }
    expect(out.rows).toEqual([expect.objectContaining({ status: 'failed', reason: 'This project was picked twice.' })])
    expect(store.listChatProjects('4244').some((p) => p.source === 'chatgpt:g-p-twice')).toBe(false)
  })

  it('explains an upload that is not ChatGPT conversations, or has no projects, and leaves no temp file', async () => {
    const bad = await upload('this is not json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'corrupt' })
    const claude = await upload([{ uuid: 'x', name: 'A Claude project', docs: [] }])
    expect(await claude.json()).toEqual({ error: 'not_chatgpt' })
    const none = await upload([conversation({ id: 'c', project: null, messages: [] })])
    expect(none.status).toBe(400)
    expect(await none.json()).toEqual({ error: 'no_projects' })
    expect(tmpFiles()).toEqual([])
  })

  it('refuses a malformed import request', async () => {
    const pv = (await (await upload(exportOf('g-p-shape', 'a'))).json()) as Preview
    for (const body of [null, 'x', [{ id: 'g-p-shape' }], [{ id: 1, name: 'a' }], [{ id: 'g-p-shape', name: 'a', instructions: 5 }]]) {
      expect((await run(pv.importId, body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('refuses a wrong media type', async () => {
    const r = await fetch(url(), { method: 'POST', headers: { Cookie: cookies['4244']!, 'X-Havn-Web': '1', 'Content-Type': 'application/json' }, body: '[]' })
    expect(r.status).toBe(415)
  })
})
