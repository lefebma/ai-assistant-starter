/** Import from Claude (card #280): mapping, review, create, dedupe and limits. */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

vi.hoisted(() => {
  // Own store, so this file never races another suite on the shared SQLite file.
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp/assistant-vitest-store'}-project-import-${process.pid}`
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../src/db.js'
import { setFileRootsForTest } from '../src/web/files.js'
import { listProjectFiles, projectFilesDir, setProjectFileLimitsForTest } from '../src/projects/files.js'
import { MAX_INSTRUCTIONS, MAX_NAME, MAX_PROJECTS, createProject, deleteProjectRows, getProject, listChatProjects } from '../src/projects/store.js'
import {
  IMPORT_TMP_DIR,
  cancelImport,
  docFileName,
  importInstructions,
  previewImport,
  runImport,
  sweepImportTmp,
  type PreviewRow,
  type ResultRow,
} from '../src/projects/import.js'
import { buildZip } from './zip-fixture.js'

const CHAT = '300'
const OVERFLOW = 'Instructions are longer than 8,000 characters. The first part goes in and the full text is saved as the file Full instructions.md.'

let tmp: string
let n = 0

interface Fixture { uuid: string; name?: unknown; description?: unknown; prompt_template?: unknown; is_starter_project?: boolean; docs?: unknown[] }

const json = (p: Fixture) => JSON.stringify({ name: `Project ${p.uuid}`, description: '', prompt_template: '', is_starter_project: false, docs: [], ...p })

/** A zip in the import temp folder, as the upload route leaves it. */
function zipOf(projects: Fixture[]): string {
  mkdirSync(IMPORT_TMP_DIR, { recursive: true })
  const path = join(IMPORT_TMP_DIR, `upload-${process.pid}-${n++}.zip`)
  writeFileSync(path, buildZip(projects.map((p, i) => ({ name: `projects/${i}-${p.uuid}.json`, data: json(p) }))))
  return path
}

async function preview(projects: Fixture[], chat = CHAT): Promise<{ importId: string; rows: PreviewRow[]; zip: string }> {
  const zip = zipOf(projects)
  const r = await previewImport(chat, zip)
  if ('error' in r) throw new Error(r.error)
  return { importId: r.importId, rows: r.rows, zip }
}

function run(importId: string, uuids: string[], chat = CHAT): ResultRow[] {
  const r = runImport(chat, importId, uuids)
  if ('error' in r) throw new Error(r.error)
  return r.rows
}

beforeAll(() => initDatabase())
beforeEach(() => {
  getDb().exec('DELETE FROM projects')
  tmp = mkdtempSync(join(tmpdir(), 'project-import-'))
  setFileRootsForTest({ root: tmp, uploadsDir: join(tmp, 'uploads') })
  setProjectFileLimitsForTest()
  rmSync(IMPORT_TMP_DIR, { recursive: true, force: true })
})
afterAll(() => {
  setFileRootsForTest(null)
  setProjectFileLimitsForTest()
  getDb().close()
  rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })
})

describe('importInstructions', () => {
  it('puts the description above the template, either one optional', () => {
    expect(importInstructions('A shop', 'Be brief.')).toEqual({ instructions: 'About this project: A shop\n\nBe brief.', full: null })
    expect(importInstructions('A shop', '')).toEqual({ instructions: 'About this project: A shop', full: null })
    expect(importInstructions('', 'Be brief.')).toEqual({ instructions: 'Be brief.', full: null })
    expect(importInstructions('', '')).toEqual({ instructions: '', full: null })
  })

  it('cuts a long text at a line break and keeps the whole of it', () => {
    const line = 'x'.repeat(99)
    const template = Array.from({ length: 90 }, () => line).join('\n') // 8,999 characters
    const r = importInstructions('', template)
    expect(r.full).toBe(template)
    expect(r.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
    expect(r.instructions.endsWith(line)).toBe(true)
    expect(template.startsWith(r.instructions + '\n')).toBe(true)
  })

  it('cuts at the limit when there is no line break', () => {
    const r = importInstructions('', 'y'.repeat(9000))
    expect(r.instructions).toBe('y'.repeat(MAX_INSTRUCTIONS))
    expect(r.full).toBe('y'.repeat(9000))
  })
})

describe('docFileName', () => {
  it('keeps text names and marks the rest as text', () => {
    expect(docFileName('Deck.pptx')).toBe('Deck.pptx.txt')
    expect(docFileName('notes.md')).toBe('notes.md')
    expect(docFileName('a.txt')).toBe('a.txt')
    expect(docFileName('sheet.csv')).toBe('sheet.csv')
  })
})

describe('previewImport', () => {
  it('lists each project without creating anything', async () => {
    const { rows } = await preview([
      { uuid: 's', name: 'How to use Claude', is_starter_project: true },
      { uuid: 'a', name: 'Acme', description: 'A shop', docs: [{ filename: 'n.md', content: 'hi' }] },
      { uuid: 'e', name: 'Empty' },
    ])
    expect(rows).toEqual([
      { uuid: 's', name: 'How to use Claude', hasInstructions: false, files: 0, starter: true, status: 'new', warnings: [], instructions: '' },
      { uuid: 'a', name: 'Acme', hasInstructions: true, files: 1, starter: false, status: 'new', warnings: [], instructions: 'About this project: A shop' },
      { uuid: 'e', name: 'Empty', hasInstructions: false, files: 0, starter: false, status: 'new', warnings: [], instructions: '' },
    ])
    expect(listChatProjects(CHAT)).toEqual([])
  })

  it('warns about long instructions', async () => {
    const { rows } = await preview([{ uuid: 'l', prompt_template: 'z'.repeat(9000) }])
    expect(rows[0]!.warnings).toEqual([OVERFLOW])
  })

  it('marks a project already imported in this chat, and only this chat', async () => {
    const first = await preview([{ uuid: 'a', name: 'Acme' }])
    run(first.importId, ['a'])
    expect((await preview([{ uuid: 'a', name: 'Acme' }])).rows[0]!.status).toBe('already')
    expect((await preview([{ uuid: 'a', name: 'Acme' }], '999')).rows[0]!.status).toBe('new')
  })

  it('shows a uuid that appears twice once', async () => {
    const { rows } = await preview([{ uuid: 'd', name: 'One' }, { uuid: 'd', name: 'Two' }])
    expect(rows.map((r) => r.name)).toEqual(['One'])
  })

  it('answers a parse error and removes the file', async () => {
    mkdirSync(IMPORT_TMP_DIR, { recursive: true })
    const path = join(IMPORT_TMP_DIR, 'bad.zip')
    writeFileSync(path, buildZip([{ name: 'conversations.json', data: '[]' }]))
    expect(await previewImport(CHAT, path)).toEqual({ error: 'not_projects' })
    expect(existsSync(path)).toBe(false)
  })
})

describe('runImport', () => {
  it('creates projects with instructions, files and their source', async () => {
    const { importId } = await preview([
      { uuid: 'a', name: 'Acme', description: 'A shop', prompt_template: 'Be brief.', docs: [{ filename: 'Deck.pptx', content: 'slides' }, { filename: 'n.md', content: 'notes' }] },
    ])
    const rows = run(importId, ['a'])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ uuid: 'a', name: 'Acme', status: 'created', leftOut: [] })
    const p = getProject(CHAT, rows[0]!.projectId)!
    expect(p.instructions).toBe('About this project: A shop\n\nBe brief.')
    expect(p.source).toBe('claude:a')
    expect(listProjectFiles(p.id).map((f) => f.name)).toEqual(['Deck.pptx.txt', 'n.md'])
    expect(readFileSync(join(projectFilesDir(p.id), 'Deck.pptx.txt'), 'utf8')).toBe('slides')
  })

  it('imports only the chosen ones', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'Acme' }, { uuid: 'b', name: 'Beta' }])
    expect(run(importId, ['b']).map((r) => r.name)).toEqual(['Beta'])
    expect(listChatProjects(CHAT).map((p) => p.name)).toEqual(['Beta'])
  })

  it('saves the full text of long instructions as a file', async () => {
    const template = Array.from({ length: 90 }, () => 'x'.repeat(99)).join('\n')
    const { importId } = await preview([{ uuid: 'l', name: 'Long', prompt_template: template }])
    const [row] = run(importId, ['l'])
    expect(row!.status).toBe('created')
    expect(row!.reason).toBe(OVERFLOW)
    const p = getProject(CHAT, row!.projectId)!
    expect(p.instructions.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS)
    expect(readFileSync(join(projectFilesDir(p.id), 'Full instructions.md'), 'utf8')).toBe(template)
  })

  it('skips a project already imported, and a whole import run twice', async () => {
    const first = await preview([{ uuid: 'a', name: 'Acme' }])
    const second = await preview([{ uuid: 'a', name: 'Acme' }, { uuid: 'b', name: 'Beta' }])
    run(first.importId, ['a'])
    expect(run(second.importId, ['a', 'b']).map((r) => r.status)).toEqual(['skipped', 'created'])
    const third = await preview([{ uuid: 'a', name: 'Acme' }, { uuid: 'b', name: 'Beta' }])
    expect(run(third.importId, ['a', 'b']).map((r) => r.status)).toEqual(['skipped', 'skipped'])
    expect(listChatProjects(CHAT)).toHaveLength(2)
  })

  it('makes one project from two previews of the same zip run together', async () => {
    const zip = zipOf([{ uuid: 'a', name: 'Acme' }])
    const one = await previewImport(CHAT, zip)
    const two = await previewImport(CHAT, zip)
    if ('error' in one || 'error' in two) throw new Error('preview failed')
    const [r1, r2] = await Promise.all([Promise.resolve().then(() => runImport(CHAT, one.importId, ['a'])), Promise.resolve().then(() => runImport(CHAT, two.importId, ['a']))])
    const statuses = [r1, r2].map((r) => ('rows' in r ? r.rows[0]!.status : r.error)).sort()
    expect(statuses).toEqual(['created', 'skipped'])
    expect(listChatProjects(CHAT)).toHaveLength(1)
  })

  it('treats a unique index hit on source as skipped', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'Acme' }])
    // Another tab wins between the check and the insert.
    const insert = getDb().prepare('INSERT INTO projects (id, chat_id, name, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('other', CHAT, 'Elsewhere', 1, 1, 'claude:a')
    expect(run(importId, ['a'])[0]!.status).toBe('skipped')
  })

  it('brings back a project the owner deleted', async () => {
    const first = await preview([{ uuid: 'a', name: 'Acme' }])
    const [row] = run(first.importId, ['a'])
    deleteProjectRows(CHAT, row!.projectId!)
    const again = await preview([{ uuid: 'a', name: 'Acme' }])
    expect(again.rows[0]!.status).toBe('new')
    expect(run(again.importId, ['a'])[0]!.status).toBe('created')
  })

  it('fails the second copy of a uuid that appears twice', async () => {
    const { importId } = await preview([{ uuid: 'd', name: 'One' }, { uuid: 'd', name: 'Two' }])
    expect(run(importId, ['d'])).toEqual([
      expect.objectContaining({ uuid: 'd', name: 'One', status: 'created' }),
      { uuid: 'd', name: 'Two', status: 'failed', reason: 'This project appears twice in the file.', leftOut: [] },
    ])
  })
})

describe('name clash', () => {
  it('adds (Claude), then (Claude 2)', async () => {
    createProject(CHAT, 'Acme')
    const { importId } = await preview([{ uuid: 'a', name: 'Acme' }, { uuid: 'b', name: 'Acme' }])
    expect(run(importId, ['a', 'b']).map((r) => r.name)).toEqual(['Acme (Claude)', 'Acme (Claude 2)'])
  })

  it('cuts the name so the suffix fits', async () => {
    const long = 'n'.repeat(MAX_NAME)
    createProject(CHAT, long)
    const { importId } = await preview([{ uuid: 'a', name: long }])
    const [row] = run(importId, ['a'])
    expect(row!.status).toBe('created')
    expect(row!.name).toBe(`${'n'.repeat(MAX_NAME - ' (Claude)'.length)} (Claude)`)
    expect(row!.name.length).toBe(MAX_NAME)
  })

  it('cuts a name over the limit before it is used', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'm'.repeat(MAX_NAME + 20) }])
    expect(run(importId, ['a'])[0]!.name).toBe('m'.repeat(MAX_NAME))
  })
})

describe('limits', () => {
  it('stops at the project limit and says why', async () => {
    const insert = getDb().prepare('INSERT INTO projects (id, chat_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (let i = 0; i < MAX_PROJECTS - 1; i++) insert.run(`p${i}`, CHAT, `Existing ${i}`, 1, 1)
    const { importId } = await preview([{ uuid: 'a', name: 'Acme' }, { uuid: 'b', name: 'Beta' }])
    expect(run(importId, ['a', 'b'])).toEqual([
      expect.objectContaining({ uuid: 'a', status: 'created' }),
      { uuid: 'b', name: 'Beta', status: 'failed', reason: 'You have reached the limit of 100 projects.', leftOut: [] },
    ])
  })

  it('imports the first 50 docs and lists the rest as left out', async () => {
    const docs = Array.from({ length: 51 }, (_, i) => ({ filename: `doc${String(i + 1).padStart(2, '0')}.md`, content: 'x' }))
    const { importId } = await preview([{ uuid: 'a', name: 'Acme', docs }])
    const [row] = run(importId, ['a'])
    expect(row!.status).toBe('created')
    expect(listProjectFiles(row!.projectId!)).toHaveLength(50)
    expect(row!.leftOut).toEqual(['doc51.md'])
  })

  it('leaves out an empty doc and still creates the project', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'Acme', docs: [{ filename: 'empty.md', content: '' }] }])
    const [row] = run(importId, ['a'])
    expect(row).toMatchObject({ status: 'created', leftOut: ['empty.md'] })
    expect(listProjectFiles(row!.projectId!)).toEqual([])
  })

  it('names a doc with no filename by its place', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'Acme', docs: [{ filename: 'a.md', content: 'x' }, { filename: 7, content: 'y' }] }])
    const [row] = run(importId, ['a'])
    expect(listProjectFiles(row!.projectId!).map((f) => f.name)).toEqual(['Document 2.txt', 'a.md'])
  })

  it('lists a doc over the size limit as left out', async () => {
    setProjectFileLimitsForTest({ fileBytes: 4 })
    const { importId } = await preview([{ uuid: 'a', name: 'Acme', docs: [{ filename: 'big.md', content: 'too big' }, { filename: 'ok.md', content: 'ok' }] }])
    const [row] = run(importId, ['a'])
    expect(row!.leftOut).toEqual(['big.md'])
    expect(listProjectFiles(row!.projectId!).map((f) => f.name)).toEqual(['ok.md'])
  })
})

describe('the import and its temp file', () => {
  it('refuses another chat\'s import and keeps its file', async () => {
    const { importId, zip } = await preview([{ uuid: 'a', name: 'Acme' }])
    expect(runImport('999', importId, ['a'])).toEqual({ error: 'import_expired' })
    cancelImport('999', importId)
    expect(existsSync(zip)).toBe(true)
    expect(listChatProjects('999')).toEqual([])
    expect(run(importId, ['a'])[0]!.status).toBe('created')
  })

  it('removes the temp file after a run, and the import is spent', async () => {
    const { importId, zip } = await preview([{ uuid: 'a', name: 'Acme' }])
    run(importId, ['a'])
    expect(existsSync(zip)).toBe(false)
    expect(runImport(CHAT, importId, ['a'])).toEqual({ error: 'import_expired' })
  })

  it('removes the temp file on cancel', async () => {
    const { importId, zip } = await preview([{ uuid: 'a', name: 'Acme' }])
    cancelImport(CHAT, importId)
    expect(existsSync(zip)).toBe(false)
    expect(runImport(CHAT, importId, ['a'])).toEqual({ error: 'import_expired' })
  })

  it('sweeps files over an hour old and keeps fresh ones', () => {
    mkdirSync(IMPORT_TMP_DIR, { recursive: true })
    const old = join(IMPORT_TMP_DIR, 'old.zip')
    const fresh = join(IMPORT_TMP_DIR, 'fresh.zip')
    writeFileSync(old, 'x')
    writeFileSync(fresh, 'x')
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(old, twoHoursAgo, twoHoursAgo)
    sweepImportTmp()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('expires an import left over an hour', async () => {
    const { importId } = await preview([{ uuid: 'a', name: 'Acme' }])
    sweepImportTmp(Date.now() + 2 * 60 * 60 * 1000)
    expect(runImport(CHAT, importId, ['a'])).toEqual({ error: 'import_expired' })
  })
})
