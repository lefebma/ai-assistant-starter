import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { root } = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'web-goals-')) }
})
vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
  PROJECT_ROOT: root,
}))

import * as goals from '../src/web/goals.js'

const file = join(root, 'PROFILE.md')
const put = (s: string) => writeFileSync(file, s)
const get = () => readFileSync(file, 'utf-8')

const PROFILE = `# About

Intro line.

## Priorities

- Ship the thing
* [ ] Call the bank
  - [x] Pay invoice
Some note line
- [X] Done upper

## Working style

- Direct
`

beforeEach(() => {
  rmSync(file, { force: true })
})

describe('readGoals', () => {
  it('parses mixed bullets inside the section only', () => {
    put(PROFILE)
    const r = goals.readGoals(root)
    expect(r.goals).toEqual([
      { index: 0, text: 'Ship the thing', done: false },
      { index: 1, text: 'Call the bank', done: false },
      { index: 2, text: 'Pay invoice', done: true },
      { index: 3, text: 'Done upper', done: true },
    ])
    expect(r.version).toMatch(/^[0-9a-f]{64}$/)
  })

  it('missing file gives none', () => {
    expect(goals.readGoals(root)).toEqual({ goals: [], version: 'none' })
  })
})

describe('writes', () => {
  it('add with a missing PROFILE.md creates the section', () => {
    const r = goals.addGoal('First goal', 'none', root)
    expect(get()).toBe('## Priorities\n\n- [ ] First goal\n')
    expect(r.goals).toEqual([{ index: 0, text: 'First goal', done: false }])
  })

  it('a stub the owner wrote into keeps their words; only the marker goes', () => {
    put('<!-- havn:profile-stub -->\n# About me\n\nI run a bakery.\n')
    goals.addGoal('Grow', goals.readGoals(root).version, root)
    expect(get()).toBe('# About me\n\nI run a bakery.\n\n## Priorities\n\n- [ ] Grow\n')
  })

  it('the shipped stub template becomes a written profile the audit counts', async () => {
    const tpl = readFileSync(join(__dirname, '..', 'templates', 'PROFILE.md.template'), 'utf-8')
    put(tpl.replace(/\{\{OWNER_NAME\}\}/g, 'Sam'))
    goals.addGoal('Land a first customer', goals.readGoals(root).version, root)
    const out = get()
    expect(out).not.toContain('havn:profile-stub')
    expect(out).not.toContain('No profile yet')
    const { profileIsUnwritten } = await import('../src/onboarding/interview-offer.js')
    expect(profileIsUnwritten(root)).toBe(false)
    const { profileHasPriorities } = await import('../src/audit/io.js')
    expect(profileHasPriorities(out)).toBe(true)
    expect(goals.readGoals(root).goals).toEqual([{ index: 0, text: 'Land a first customer', done: false }])
  })

  it('add inserts after the last bullet of an existing section', () => {
    put(PROFILE)
    goals.addGoal('New one', goals.readGoals(root).version, root)
    const lines = get().split('\n')
    const i = lines.indexOf('- [ ] New one')
    expect(lines[i - 1]).toBe('- [X] Done upper')
    expect(lines.length).toBe(PROFILE.split('\n').length + 1)
  })

  it('add under an empty heading works', () => {
    put('## Priorities\n\n## Other\n')
    goals.addGoal('A', goals.readGoals(root).version, root)
    expect(get()).toBe('## Priorities\n\n- [ ] A\n## Other\n')
  })

  it('done toggle changes exactly one line', () => {
    put(PROFILE)
    goals.setGoalDone(0, true, goals.readGoals(root).version, root)
    const a = PROFILE.split('\n')
    const b = get().split('\n')
    expect(b.length).toBe(a.length)
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y)
    expect(diff).toEqual([['- Ship the thing', '- [x] Ship the thing']])
  })

  it('update keeps done state and indent; delete removes one line', () => {
    put(PROFILE)
    goals.updateGoal(2, 'Pay the big invoice', goals.readGoals(root).version, root)
    expect(get()).toContain('  - [x] Pay the big invoice\n')
    goals.deleteGoal(1, goals.readGoals(root).version, root)
    expect(get()).not.toContain('Call the bank')
    expect(get().split('\n').length).toBe(PROFILE.split('\n').length - 1)
  })

  it('a stale version conflicts and leaves the file byte-identical', () => {
    put(PROFILE)
    const v = goals.readGoals(root).version
    put(PROFILE + 'edited by hand\n')
    const before = readFileSync(file)
    expect(() => goals.addGoal('x', v, root)).toThrow(goals.GoalConflict)
    expect(() => goals.setGoalDone(0, true, v, root)).toThrow(goals.GoalConflict)
    expect(() => goals.addGoal('x', 'none', root)).toThrow(goals.GoalConflict)
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('rejects empty, overlong, multi-line text and bad indexes without touching the file', () => {
    put(PROFILE)
    const v = goals.readGoals(root).version
    for (const t of ['', '   ', 'a'.repeat(301), 'a\nb', 'a\r']) {
      expect(() => goals.addGoal(t, v, root)).toThrow(goals.GoalInvalid)
    }
    expect(() => goals.updateGoal(0, 'a\nb', v, root)).toThrow(goals.GoalInvalid)
    expect(() => goals.deleteGoal(99, v, root)).toThrow(goals.GoalInvalid)
    expect(get()).toBe(PROFILE)
    expect(goals.addGoal('a'.repeat(300), v, root).goals).toHaveLength(5)
  })

  it('leaves no temp files behind', () => {
    goals.addGoal('x', 'none', root)
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('routes', () => {
  let port = 0
  let server: typeof import('../src/http-server.js')
  let cookie = ''

  beforeAll(async () => {
    process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-goals-store-'))
    const db = await import('../src/db.js')
    db.initDatabase()
    const sessions = await import('../src/web/sessions.js')
    server = await import('../src/http-server.js')
    // Band 5545-5559.
    port = 5545 + Math.floor(Math.random() * 15)
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
    await server.stopHttpServer()
  })

  const H = () => ({ Cookie: cookie, 'Content-Type': 'application/json' })
  const url = (p: string) => `http://127.0.0.1:${port}${p}`
  const act = (body: unknown) => fetch(url('/api/web/goals'), { method: 'POST', headers: H(), body: JSON.stringify(body) })

  it('requires a session', async () => {
    expect((await fetch(url('/api/web/goals'))).status).toBe(401)
    expect((await fetch(url('/api/web/projects'))).status).toBe(401)
  })

  it('lists projects with General first', async () => {
    const r = await fetch(url('/api/web/projects'), { headers: H() })
    expect(r.status).toBe(200)
    const body = (await r.json()) as any[]
    expect(body[0]).toEqual({ id: '', name: 'General', company: '', status: '', statePath: '' })
  })

  it('add, done, update, delete round trip, and 409 with fresh goals on a stale version', async () => {
    let r = await (await fetch(url('/api/web/goals'), { headers: H() })).json() as any
    expect(r).toEqual({ goals: [], version: 'none' })
    r = await (await act({ action: 'add', text: 'One', version: r.version })).json()
    expect(r.goals).toEqual([{ index: 0, text: 'One', done: false }])
    const stale = r.version
    r = await (await act({ action: 'done', index: 0, done: true, version: r.version })).json()
    expect(r.goals[0].done).toBe(true)
    r = await (await act({ action: 'update', index: 0, text: 'Uno', version: r.version })).json()
    expect(r.goals[0].text).toBe('Uno')

    const before = get()
    const conflict = await act({ action: 'add', text: 'Late', version: stale })
    expect(conflict.status).toBe(409)
    const cb = (await conflict.json()) as any
    expect(cb.error).toBe('goals_changed')
    expect(cb.goals).toEqual([{ index: 0, text: 'Uno', done: true }])
    expect(cb.version).toBe(r.version)
    expect(get()).toBe(before)

    expect((await act({ action: 'add', text: 'a\nb', version: r.version })).status).toBe(400)
    expect((await act({ action: 'nope', version: r.version })).status).toBe(400)
    r = await (await act({ action: 'delete', index: 0, version: r.version })).json()
    expect(r.goals).toEqual([])
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
