/**
 * Card #249: images, files and long pasted text sent with a web chat message.
 * The project root is a temp folder, so uploads, the conversation folders and
 * the file route all work on a fixture.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'web-attach-root-'))
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-attach-store-'))
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
  result: AgentRunResult = { text: 'Looked at it.', newSessionId: 'sess-a' }
  gate: Promise<void> | null = null
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options)
    if (this.gate) await this.gate
    return this.result
  }
  async runOnce(): Promise<string> { return 'once' }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> { return new Map() }
}

let port = 0
let sessions: typeof import('../src/web/sessions.js')
let server: typeof import('../src/http-server.js')
let conv: typeof import('../src/web/conversations.js')
let runtimeMod: typeof import('../src/runtime/index.js')
let bot: typeof import('../src/bot.js')
let rt: FakeRuntime
let cookie = ''
const UPLOADS = join(h.root, 'workspace', 'uploads')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f9f0a40000000049454e44ae426082', 'hex')

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  conv = await import('../src/web/conversations.js')
  runtimeMod = await import('../src/runtime/index.js')
  bot = await import('../src/bot.js')
  server = await import('../src/http-server.js')
  port = 5570 + Math.floor(Math.random() * 25)
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
  // UPLOADS_DIR is fixed at import from env.js; point the file routes at the fixture.
  ;(await import('../src/web/files.js')).setFileRootsForTest({ root: h.root, uploadsDir: UPLOADS })
  const { token } = sessions.mintWebLink('4242')
  cookie = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
  writeFileSync(join(h.root, 'PROFILE.md'), '# me')
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
const H = () => ({ Cookie: cookie, 'Content-Type': 'application/json' })
const post = (path: string, body: unknown = {}) => fetch(base() + path, { method: 'POST', headers: H(), body: JSON.stringify(body) })

function useRuntime(): FakeRuntime {
  rt = new FakeRuntime()
  runtimeMod.setAgentRuntime(rt)
  return rt
}

async function newConv(): Promise<string> {
  return ((await (await post('/api/web/conversations', { projectId: '' })).json()) as any).conversation.id
}

async function upload(name: string, body: Buffer | string): Promise<string> {
  const r = await fetch(base() + '/api/web/files/upload?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Havn-Web': '1' },
    body,
  })
  expect(r.status).toBe(200)
  return ((await r.json()) as any).path
}

function events(text: string): Array<{ name: string; data: any }> {
  return text.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('event:')).map((b) => ({
    name: /^event: (.*)$/m.exec(b)![1]!,
    data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!),
  }))
}

describe('sending attachments', () => {
  it('an image goes to the agent as a photo line, moves into the chat folder, and opens from the history', async () => {
    useRuntime()
    const id = await newConv()
    const path = await upload('image.png', PNG)
    expect(path).toBe('workspace/uploads/image.png')
    const r = await post(`/api/web/conversations/${id}/chat`, { text: 'What is this?', attachments: [path] })
    expect(events(await r.text()).at(-1)!.name).toBe('done')

    const moved = join(UPLOADS, 'chat', id, 'image.png')
    expect(existsSync(moved)).toBe(true)
    expect(existsSync(join(h.root, path))).toBe(false)
    expect(rt.calls[0]!.message).toContain(`[Photo attached: ${moved}]\nWhat is this?`)

    const [user] = conv.listMessages(id)
    expect(user).toMatchObject({ role: 'user', content: 'What is this?', files: [{ path: moved, name: 'image.png', kind: 'photo' }] })
    const listed = (await (await fetch(`${base()}/api/web/conversations/${id}/messages`, { headers: H() })).json()) as any
    expect(listed.messages[0].files).toEqual([{ index: 0, name: 'image.png', kind: 'photo' }])
    const img = await fetch(`${base()}/api/web/messages/${listed.messages[0].id}/files/0`, { headers: H() })
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('an image alone is enough: no text needed, and the chat is titled for it', async () => {
    useRuntime()
    const id = await newConv()
    const path = await upload('shot.png', PNG)
    await (await post(`/api/web/conversations/${id}/chat`, { text: '', attachments: [path] })).text()
    expect(rt.calls[0]!.message).toMatch(/\[Photo attached: .*shot\.png\]\nPlease analyze this image\./)
    expect(conv.getConversation('4242', id)!.title).toBe('Image')
  })

  it('pasted text is inlined for the agent, kept as a file, and served back', async () => {
    useRuntime()
    const id = await newConv()
    const pasted = 'line one\n  indented two\nline three'
    await (await post(`/api/web/conversations/${id}/chat`, { text: 'Summarise', pastes: [pasted] })).text()
    expect(rt.calls[0]!.message).toContain(`lines, saved at ${join(UPLOADS, 'chat', id, 'pasted-text.txt')}]\n<pasted-text>\n${pasted}\n</pasted-text>\nSummarise`)
    const [user] = conv.listMessages(id)
    expect(user!.files).toEqual([{ path: join(UPLOADS, 'chat', id, 'pasted-text.txt'), name: 'pasted-text.txt', kind: 'document', pasted: true }])
    expect(readFileSync(user!.files[0]!.path, 'utf-8')).toBe(pasted)
    const listed = (await (await fetch(`${base()}/api/web/conversations/${id}/messages`, { headers: H() })).json()) as any
    expect(listed.messages[0].files[0]).toEqual({ index: 0, name: 'pasted-text.txt', kind: 'document', pasted: true })
    const t = await fetch(`${base()}/api/web/messages/${listed.messages[0].id}/files/0`, { headers: H() })
    expect(await t.text()).toBe(pasted)
  })

  it('a document is offered as a document, and two pastes do not share a file', async () => {
    useRuntime()
    const id = await newConv()
    const path = await upload('notes.pdf', '%PDF-1.4 fake')
    await (await post(`/api/web/conversations/${id}/chat`, { text: 'Read these', attachments: [path], pastes: ['a', 'b'] })).text()
    const msg = rt.calls[0]!.message
    expect(msg).toContain(`[Document attached: notes.pdf at ${join(UPLOADS, 'chat', id, 'notes.pdf')}]`)
    expect(conv.listMessages(id)[0]!.files.map((f) => f.name)).toEqual(['notes.pdf', 'pasted-text.txt', 'pasted-text-1.txt'])
  })

  it('deleting the chat deletes its attachments', async () => {
    useRuntime()
    const id = await newConv()
    const path = await upload('gone.png', PNG)
    await (await post(`/api/web/conversations/${id}/chat`, { text: 'x', attachments: [path] })).text()
    expect(existsSync(join(UPLOADS, 'chat', id))).toBe(true)
    expect((await post(`/api/web/conversations/${id}/delete`)).status).toBe(200)
    expect(existsSync(join(UPLOADS, 'chat', id))).toBe(false)
  })
})

describe('what is refused', () => {
  const refused = async (body: unknown) => {
    useRuntime()
    const id = await newConv()
    const r = await post(`/api/web/conversations/${id}/chat`, body)
    return { status: r.status, code: ((await r.json()) as any).error, rt }
  }

  it('anything that is not a fresh upload: a project file, a traversal, another chat\'s file, a hidden part', async () => {
    mkdirSync(join(UPLOADS, 'chat', 'other'), { recursive: true })
    writeFileSync(join(UPLOADS, 'chat', 'other', 'theirs.png'), PNG)
    for (const p of ['PROFILE.md', '../etc/passwd', 'workspace/uploads/../../PROFILE.md', 'workspace/uploads/chat/other/theirs.png', 'workspace/uploads/chat']) {
      const r = await refused({ text: 'x', attachments: [p] })
      expect([r.status, p]).toEqual([400, p])
      expect(r.rt.calls).toHaveLength(0)
    }
    expect(existsSync(join(h.root, 'PROFILE.md'))).toBe(true)
  })

  it('a missing upload, a command or button answer with attachments, too many, too long', async () => {
    expect(await refused({ text: 'x', attachments: ['workspace/uploads/never.png'] })).toMatchObject({ status: 400, code: 'attachment_missing' })
    const path = await upload('keep.png', PNG)
    expect(await refused({ text: '/newchat', attachments: [path] })).toMatchObject({ status: 400, code: 'attachments_with_command' })
    expect(await refused({ text: '[button_click]: Send', pastes: ['x'] })).toMatchObject({ status: 400, code: 'attachments_with_command' })
    expect(existsSync(join(h.root, path))).toBe(true) // a refused message leaves the upload where it was
    expect(await refused({ text: 'x', pastes: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatchObject({ status: 400, code: 'too_many_attachments' })
    expect(await refused({ text: 'x', pastes: ['y'.repeat(200_001)] })).toMatchObject({ status: 400, code: 'paste_too_long' })
    expect(await refused({ text: 'x', attachments: 'keep.png' })).toMatchObject({ status: 400, code: 'bad_attachments' })
    expect(await refused({ text: '', pastes: ['   '] })).toMatchObject({ status: 400, code: 'bad_text' })
  })

  it('a busy chat queues the message and leaves the upload in place until it starts (card #250)', async () => {
    const r1 = useRuntime()
    let release!: () => void
    r1.gate = new Promise((r) => { release = r })
    const id = await newConv()
    const first = post(`/api/web/conversations/${id}/chat`, { text: 'slow' })
    for (let i = 0; i < 50 && !r1.calls.length; i++) await new Promise((r) => setTimeout(r, 10))
    const path = await upload('wait.png', PNG)
    const r = await post(`/api/web/conversations/${id}/chat`, { text: 'x', attachments: [path] })
    expect(r.status).toBe(202)
    expect(((await r.json()) as any).item.files).toEqual([{ name: 'wait.png', kind: 'photo' }])
    expect(existsSync(join(h.root, path))).toBe(true)
    release()
    await (await first).text()
    // Once it runs, the upload moves into the conversation like any other.
    await vi.waitFor(() => expect(existsSync(join(h.root, path))).toBe(false))
    await vi.waitFor(() => expect(conv.listMessages(id).filter((m) => m.role === 'user').at(-1)!.files.map((f) => f.name)).toEqual(['wait.png']))
  })
})
