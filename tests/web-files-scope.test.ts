/**
 * Card #292: the Files panel and the chat box keep each chat's files to that
 * chat. The main chat (4242) sees everything; a second authorized chat (777)
 * sees only its own conversations, projects and unsent uploads, and gets the
 * same 404 as a missing file for the rest.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'web-scope-root-'))
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-scope-store-'))
  return { root }
})

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
  PROJECT_ROOT: h.root,
}))

import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../src/runtime/types.js'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  calls: AgentRunOptions[] = []
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options)
    return { text: 'ok', newSessionId: 'sess' }
  }
  async runOnce(): Promise<string> { return 'once' }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> { return new Map() }
}

let port = 0
let server: typeof import('../src/http-server.js')
let conv: typeof import('../src/web/conversations.js')
let store: typeof import('../src/projects/store.js')
let runtimeMod: typeof import('../src/runtime/index.js')
let bot: typeof import('../src/bot.js')
const cookies: Record<string, string> = {}
const UPLOADS = join(h.root, 'workspace', 'uploads')

// What the main chat owns, and one file with no owner.
let mainConv = ''
let mainProject = ''
let otherConv = ''
let otherProject = ''

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  db.addAuthorizedChat('777', 'second person', '4242')
  const sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  store = await import('../src/projects/store.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  port = 5600 + Math.floor(Math.random() * 25)
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
  ;(await import('../src/web/files.js')).setFileRootsForTest({ root: h.root, uploadsDir: UPLOADS })
  for (const chat of ['4242', '777']) {
    const { token } = sessions.mintWebLink(chat)
    cookies[chat] = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
  }

  mainConv = conv.createConversation('4242', '').id
  otherConv = conv.createConversation('777', '').id
  const p1 = store.createProject('4242', 'Client A')
  const p2 = store.createProject('777', 'Client B')
  if (!('project' in p1) || !('project' in p2)) throw new Error('project fixture')
  mainProject = p1.project.id
  otherProject = p2.project.id
  for (const [dir, name] of [
    [join(UPLOADS, 'chat', mainConv), 'main.png'],
    [join(UPLOADS, 'chat', otherConv), 'other.png'],
    [join(UPLOADS, 'projects', mainProject), 'brief.md'],
    [join(UPLOADS, 'projects', otherProject), 'notes.md'],
    [join(UPLOADS, 'tray', '4242'), 'unsent.txt'],
    [UPLOADS, 'voice-note.ogg'],
  ] as const) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), 'x')
  }
})

afterAll(async () => {
  ;(await import('../src/web/files.js')).setFileRootsForTest(null)
  runtimeMod.setAgentRuntime(null)
  await server.stopHttpServer()
})

afterEach(async () => {
  await bot.turnsIdle()
})

const base = () => `http://127.0.0.1:${port}`
const list = (chat: string, path: string) =>
  fetch(base() + '/api/web/files?path=' + encodeURIComponent(path), { headers: { Cookie: cookies[chat]! } })
const raw = (chat: string, path: string) =>
  fetch(base() + '/api/web/files/raw?path=' + encodeURIComponent(path), { headers: { Cookie: cookies[chat]! } })
const names = async (r: Response) => ((await r.json()) as { entries: Array<{ name: string }> }).entries.map((e) => e.name).sort()

async function upload(chat: string, name: string): Promise<string> {
  const r = await fetch(base() + '/api/web/files/upload?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { Cookie: cookies[chat]!, 'Content-Type': 'application/octet-stream', 'X-Havn-Web': '1' },
    body: 'hello',
  })
  expect(r.status).toBe(200)
  return ((await r.json()) as { path: string }).path
}

describe('the main chat', () => {
  it('sees every chat, project, unsent upload and loose file', async () => {
    expect(await names(await list('4242', 'workspace/uploads'))).toEqual(['chat', 'projects', 'tray', 'voice-note.ogg'])
    expect(await names(await list('4242', 'workspace/uploads/chat'))).toEqual([mainConv, otherConv].sort())
    expect(await names(await list('4242', 'workspace/uploads/projects'))).toEqual([mainProject, otherProject].sort())
    for (const p of [
      `workspace/uploads/chat/${otherConv}/other.png`,
      `workspace/uploads/projects/${otherProject}/notes.md`,
      'workspace/uploads/voice-note.ogg',
    ]) {
      expect((await raw('4242', p)).status).toBe(200)
    }
  })
})

describe('another chat', () => {
  it('lists only its own conversations and projects, and no loose files', async () => {
    expect(await names(await list('777', 'workspace/uploads'))).toEqual(['chat', 'projects', 'tray'])
    expect(await names(await list('777', 'workspace/uploads/chat'))).toEqual([otherConv])
    expect(await names(await list('777', 'workspace/uploads/projects'))).toEqual([otherProject])
    expect(await names(await list('777', 'workspace/uploads/tray'))).toEqual([])
  })

  it('opens its own files', async () => {
    expect((await raw('777', `workspace/uploads/chat/${otherConv}/other.png`)).status).toBe(200)
    expect((await raw('777', `workspace/uploads/projects/${otherProject}/notes.md`)).status).toBe(200)
    expect(await names(await list('777', `workspace/uploads/chat/${otherConv}`))).toEqual(['other.png'])
  })

  it('gets a plain 404 for what is not its own, by direct path and by folder', async () => {
    for (const p of [
      `workspace/uploads/chat/${mainConv}/main.png`,
      `workspace/uploads/projects/${mainProject}/brief.md`,
      'workspace/uploads/tray/4242/unsent.txt',
      'workspace/uploads/voice-note.ogg',
      `workspace/uploads/chat/${mainConv}/../${mainConv}/main.png`,
    ]) {
      const r = await raw('777', p)
      expect(r.status, p).toBe(404)
      expect(await r.json()).toMatchObject({ error: 'not_found' })
    }
    for (const p of [`workspace/uploads/chat/${mainConv}`, `workspace/uploads/projects/${mainProject}`, 'workspace/uploads/tray/4242']) {
      expect((await list('777', p)).status, p).toBe(404)
    }
  })

  it('is refused another spelling of the same path on a case-insensitive disk', async () => {
    const variant = `WORKSPACE/Uploads/chat/${mainConv}/main.png`
    if (!existsSync(join(h.root, variant))) return // case-sensitive disk: nothing to slip past
    expect((await raw('777', variant)).status).toBe(404)
  })

  it('still sees the rest of the files the panel shows', async () => {
    writeFileSync(join(h.root, 'PROFILE.md'), '# me')
    expect((await raw('777', 'PROFILE.md')).status).toBe(200)
  })
})

describe('the chat box', () => {
  it('keeps each chat to its own unsent uploads', async () => {
    const rt = new FakeRuntime()
    runtimeMod.setAgentRuntime(rt)
    const mine = await upload('4242', 'contract.pdf')
    expect(mine).toBe('workspace/uploads/tray/4242/contract.pdf')
    const theirs = await upload('777', 'contract.pdf')
    expect(theirs).toBe('workspace/uploads/tray/777/contract.pdf')

    // 777 tries to send the main chat's upload in its own conversation.
    const r = await fetch(`${base()}/api/web/conversations/${otherConv}/chat`, {
      method: 'POST',
      headers: { Cookie: cookies['777']!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'read this', attachments: [mine] }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'bad_attachments' })
    expect(existsSync(join(h.root, mine))).toBe(true)
    expect(rt.calls).toHaveLength(0)

    // A Telegram download at the top of the folder cannot be taken either.
    const loose = await fetch(`${base()}/api/web/conversations/${otherConv}/chat`, {
      method: 'POST',
      headers: { Cookie: cookies['777']!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'read this', attachments: ['workspace/uploads/voice-note.ogg'] }),
    })
    expect(loose.status).toBe(400)
    expect(existsSync(join(UPLOADS, 'voice-note.ogg'))).toBe(true)
  })
})

describe('clearing old uploads', () => {
  it('clears day-old unsent uploads from every tray and keeps fresh ones', async () => {
    const { cleanupOldUploads } = await import('../src/media.js')
    const dir = mkdtempSync(join(tmpdir(), 'web-scope-sweep-'))
    mkdirSync(join(dir, 'tray', '777'), { recursive: true })
    mkdirSync(join(dir, 'chat', 'c1'), { recursive: true })
    const old = join(dir, 'tray', '777', 'old.txt')
    const fresh = join(dir, 'tray', '777', 'fresh.txt')
    const sent = join(dir, 'chat', 'c1', 'sent.txt')
    for (const f of [old, fresh, sent]) writeFileSync(f, 'x')
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(old, twoDaysAgo, twoDaysAgo)
    utimesSync(sent, twoDaysAgo, twoDaysAgo)
    cleanupOldUploads(undefined, dir)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(sent)).toBe(true) // a sent attachment belongs to its chat history
  })
})
