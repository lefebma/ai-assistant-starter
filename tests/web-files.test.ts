import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
}))

let port = 0
let sessions: typeof import('../src/web/sessions.js')
let server: typeof import('../src/http-server.js')
let files: typeof import('../src/web/files.js')
let cookie = ''
let root = ''
let uploads = ''

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-files-'))
  const base = mkdtempSync(join(tmpdir(), 'web-files-fx-'))
  root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'store', 'vault'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, 'workspace', 'uploads'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, '.env'), 'SECRET=1')
  writeFileSync(join(root, 'store', 'vault', 'secrets.json'), '{"k":"v"}')
  writeFileSync(join(root, 'src', 'x.ts'), 'export {}')
  writeFileSync(join(root, 'roles.json'), '{}')
  writeFileSync(join(root, 'notes', 'a.md'), '# hello')
  writeFileSync(join(root, 'notes', 'page.html'), '<script>alert(1)</script>')
  writeFileSync(join(root, 'notes', 'pic.svg'), '<svg onload="alert(1)"/>')
  writeFileSync(join(root, 'notes', 'blob.bin'), 'zz')
  writeFileSync(join(root, 'notes', 'api_token.txt'), 'tok')
  writeFileSync(join(root, 'readme.txt'), 'top')
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE')
  symlinkSync(outside, join(root, 'link-out'))
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out-file'))
  symlinkSync(join(root, 'store'), join(root, 'link-store'))
  symlinkSync(join(root, '.env'), join(root, 'link-env'))
  uploads = join(root, 'workspace', 'uploads')

  const db = await import('../src/db.js')
  db.initDatabase()
  sessions = await import('../src/web/sessions.js')
  files = await import('../src/web/files.js')
  files.setFileRootsForTest({ root, uploadsDir: uploads })
  server = await import('../src/http-server.js')
  port = 5900 + Math.floor(Math.random() * 90) * 3
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
  const { token } = sessions.mintWebLink('4242')
  cookie = `havn_web=${sessions.exchangeWebLink(token, 'test')!.sessionId}`
})

afterAll(async () => {
  files.setFileRootsForTest(null)
  await server.stopHttpServer()
})

const base = () => `http://127.0.0.1:${port}`
const get = (p: string) => fetch(base() + p, { headers: { Cookie: cookie } })
const raw = (p: string) => get('/api/web/files/raw?path=' + p)
const upload = (name: string, body: BodyInit, extra: Record<string, string> = {}) =>
  fetch(base() + '/api/web/files/upload?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Havn-Web': '1', ...extra },
    body,
    // @ts-expect-error node fetch
    duplex: 'half',
  })

describe('containment: every attempt is a 404 without bytes', () => {
  const attempts: Array<[string, string]> = [
    ['dotdot', encodeURIComponent('../outside/secret.txt')],
    ['deep dotdot', encodeURIComponent('notes/../../outside/secret.txt')],
    ['absolute', encodeURIComponent('/etc/passwd')],
    ['absolute into root', '__ABS_ROOT__'],
    ['encoded dotdot, once', '%2e%2e/outside/secret.txt'],
    ['double encoded dotdot', encodeURIComponent('%2e%2e/outside/secret.txt')],
    ['double encoded slash', encodeURIComponent('notes%2f..%2f..%2foutside')],
    ['symlink dir out', encodeURIComponent('link-out/secret.txt')],
    ['symlink file out', encodeURIComponent('link-out-file')],
    ['symlink to store', encodeURIComponent('link-store/vault/secrets.json')],
    ['symlink to env', encodeURIComponent('link-env')],
    ['vault secrets', encodeURIComponent('store/vault/secrets.json')],
    ['env', encodeURIComponent('.env')],
    ['src file', encodeURIComponent('src/x.ts')],
    ['roles.json', encodeURIComponent('roles.json')],
    ['token-named file', encodeURIComponent('notes/api_token.txt')],
    ['backslash', encodeURIComponent('notes\\a.md')],
    ['nul', encodeURIComponent('notes/a.md\0')],
    ['dot segment', encodeURIComponent('./readme.txt')],
    ['double slash', encodeURIComponent('notes//a.md')],
  ]
  for (const [label, p0] of attempts) {
    it(label, async () => {
      const p = p0 === '__ABS_ROOT__' ? encodeURIComponent(join(root, 'readme.txt')) : p0
      const r = await raw(p)
      expect(r.status).toBe(404)
      const body = await r.text()
      expect(body).not.toContain('OUTSIDE')
      expect(body).not.toContain('SECRET=1')
      expect(body).not.toContain('"k"')
      const l = await get('/api/web/files?path=' + p)
      expect(l.status).toBe(404)
    })
  }

  it('resolveVisible agrees', () => {
    expect(files.resolveVisible('notes/a.md', root)?.rel).toBe('notes/a.md')
    expect(files.resolveVisible('', root)?.isDir).toBe(true)
    expect(files.resolveVisible('link-out', root)).toBeNull()
    expect(files.resolveVisible('..', root)).toBeNull()
  })

  it('needs a session', async () => {
    const r = await fetch(base() + '/api/web/files/raw?path=readme.txt')
    expect(r.status).toBe(401)
  })
})

describe('listing and preview', () => {
  it('lists visible entries only, directories first', async () => {
    const r = await get('/api/web/files')
    expect(r.status).toBe(200)
    const { entries } = (await r.json()) as { entries: Array<{ name: string; path: string; isDir: boolean; size: number; modifiedAt: number }> }
    const names = entries.map((e) => e.name)
    expect(names).toEqual(['notes', 'workspace', 'readme.txt'])
    expect(entries[0]).toMatchObject({ name: 'notes', path: 'notes', isDir: true })
    expect(entries[2]).toMatchObject({ isDir: false, size: 3 })
    expect(typeof entries[2].modifiedAt).toBe('number')
  })

  it('hides tokens inside a subdirectory', async () => {
    const r = await get('/api/web/files?path=notes')
    const { entries } = (await r.json()) as { entries: Array<{ name: string }> }
    expect(entries.map((e) => e.name)).toEqual(['a.md', 'blob.bin', 'page.html', 'pic.svg'])
  })

  it('serves md as text/plain with nosniff', async () => {
    const r = await raw('notes%2Fa.md')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await r.text()).toBe('# hello')
  })

  it('never renders html', async () => {
    const r = await raw('notes%2Fpage.html')
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('serves svg as an image with a locked-down CSP', async () => {
    const r = await raw('notes%2Fpic.svg')
    expect(r.headers.get('content-type')).toBe('image/svg+xml')
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('downloads unknown types', async () => {
    const r = await raw('notes%2Fblob.bin')
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('a directory is not a raw file', async () => {
    expect((await raw('notes')).status).toBe(404)
  })
})

describe('upload', () => {
  it('sanitises ../../.env and stays in uploads', async () => {
    const r = await upload('../../.env', 'hello')
    expect(r.status).toBe(200)
    const { path } = (await r.json()) as { path: string }
    expect(path.startsWith('workspace/uploads/')).toBe(true)
    const name = path.split('/').pop()!
    expect(name.startsWith('.')).toBe(false)
    expect(name).toBe('_.._.._.env')
    expect(readFileSync(join(root, path), 'utf8')).toBe('hello')
    expect(existsSync(join(root, '.env'))).toBe(true)
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SECRET=1')
  })

  it('never overwrites: suffix -1, -2', async () => {
    const a = (await (await upload('dup.txt', 'a')).json()) as { path: string }
    const b = (await (await upload('dup.txt', 'b')).json()) as { path: string }
    const c = (await (await upload('dup.txt', 'c')).json()) as { path: string }
    expect(a.path).toBe('workspace/uploads/dup.txt')
    expect(b.path).toBe('workspace/uploads/dup-1.txt')
    expect(c.path).toBe('workspace/uploads/dup-2.txt')
    expect(readFileSync(join(root, a.path), 'utf8')).toBe('a')
  })

  it('caps the name at 120 characters and replaces odd characters', async () => {
    const r = await upload('a<b>' + 'x'.repeat(200) + '.txt', 'z')
    const { path } = (await r.json()) as { path: string }
    expect(path.split('/').pop()!.length).toBeLessThanOrEqual(120)
    expect(path).not.toMatch(/[<>]/)
  })

  it('413 over 25 MB, streamed, and leaves nothing behind', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1)
    let sent = 0
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= 27) return controller.close()
        sent++
        controller.enqueue(chunk)
      },
    })
    let status = 0
    try {
      status = (await upload('big.bin', body)).status
    } catch {
      status = 413 // server closed the socket after answering
    }
    expect(status).toBe(413)
    await new Promise((r) => setTimeout(r, 100))
    expect(readdirSync(uploads).some((n) => n.startsWith('big') || n.endsWith('.part'))).toBe(false)
  })

  it('403 without X-Havn-Web', async () => {
    const r = await fetch(base() + '/api/web/files/upload?name=x.txt', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: 'x',
    })
    expect(r.status).toBe(403)
    expect(existsSync(join(uploads, 'x.txt'))).toBe(false)
  })

  it('400 without a name, 415 for a JSON body', async () => {
    expect((await upload('', 'x')).status).toBe(400)
    const r = await fetch(base() + '/api/web/files/upload?name=a.txt', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Havn-Web': '1' },
      body: '{}',
    })
    expect(r.status).toBe(415)
  })
})
