/** Claude export parser (card #280): reads projects-000.zip, a file a customer uploads and may not trust. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZIP_LIMITS, isManifest, parseClaudeExport, setZipLimitsForTest } from '../src/projects/claude-export.js'
import { buildZip, type FixtureEntry } from './zip-fixture.js'

const project = (uuid: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  uuid,
  name: `Project ${uuid}`,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  creator: { uuid: 'u-1', full_name: 'Test Person' },
  is_private: true,
  description: `About ${uuid}`,
  prompt_template: `Be helpful about ${uuid}.`,
  is_starter_project: false,
  docs: [],
  ...extra,
})

let dir: string
let n = 0
function writeZip(entries: FixtureEntry[]): string {
  const path = join(dir, `fixture-${n++}.zip`)
  writeFileSync(path, buildZip(entries))
  return path
}

function openFds(): number {
  try { return readdirSync('/dev/fd').length } catch { return readdirSync('/proc/self/fd').length }
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'claude-export-test-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
afterEach(() => { setZipLimitsForTest(null) })

describe('parseClaudeExport', () => {
  it('reads three projects, marks the starter and keeps docs in order', async () => {
    const path = writeZip([
      { name: 'projects/aaa.json', data: project('aaa', {
        docs: [
          { uuid: 'd1', filename: 'deck.pptx', content: 'Slide one text', created_at: '2026-01-01T00:00:00Z' },
          { uuid: 'd2', filename: 'notes.md', content: '# Notes', created_at: '2026-01-01T00:00:00Z' },
        ],
      }) },
      { name: 'projects/bbb.json', data: project('bbb', { is_starter_project: true, name: 'How to use Claude' }) },
      { name: 'projects/ccc.json', data: project('ccc', { description: '', prompt_template: '' }), method: 0 },
    ])
    const r = await parseClaudeExport(path)
    expect(r).toEqual({
      ok: true,
      unreadable: 0,
      projects: [
        {
          uuid: 'aaa', name: 'Project aaa', description: 'About aaa', template: 'Be helpful about aaa.', starter: false,
          docs: [{ filename: 'deck.pptx', content: 'Slide one text' }, { filename: 'notes.md', content: '# Notes' }],
        },
        { uuid: 'bbb', name: 'How to use Claude', description: 'About bbb', template: 'Be helpful about bbb.', starter: true, docs: [] },
        { uuid: 'ccc', name: 'Project ccc', description: '', template: '', starter: false, docs: [] },
      ],
    })
  })

  it('treats non-string fields as absent', async () => {
    const path = writeZip([
      { name: 'projects/x.json', data: JSON.stringify({
        uuid: 'x', name: 42, description: { a: 1 }, prompt_template: ['no'], is_starter_project: 'true',
        docs: [
          { filename: 'kept.md', content: 'text' },
          { filename: 'binary.pdf', content: { bytes: [1, 2] } },
          { filename: 7, content: 'no name' },
          'not an object',
          null,
        ],
      }) },
      { name: 'projects/y.json', data: JSON.stringify({ uuid: 'y', docs: 'nope' }) },
    ])
    const r = await parseClaudeExport(path)
    expect(r).toEqual({
      ok: true,
      unreadable: 0,
      projects: [
        { uuid: 'x', name: '', description: '', template: '', starter: false, docs: [{ filename: 'kept.md', content: 'text' }, { filename: '', content: 'no name' }] },
        { uuid: 'y', name: '', description: '', template: '', starter: false, docs: [] },
      ],
    })
  })

  it('counts a project without a uuid string, or bad JSON, as unreadable and keeps the rest', async () => {
    const path = writeZip([
      { name: 'projects/good.json', data: project('good') },
      { name: 'projects/nouuid.json', data: JSON.stringify({ name: 'No id' }) },
      { name: 'projects/numuuid.json', data: JSON.stringify({ uuid: 5, name: 'Number id' }) },
      { name: 'projects/emptyuuid.json', data: JSON.stringify({ uuid: '', name: 'Empty id' }) },
      { name: 'projects/array.json', data: '[1,2,3]' },
      { name: 'projects/broken.json', data: '{"uuid": "broken", ' },
      { name: 'projects/enc.json', data: project('enc'), flags: 0x1 },
      { name: 'projects/also.json', data: project('also') },
    ])
    const r = await parseClaudeExport(path)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.projects.map(p => p.uuid)).toEqual(['good', 'also'])
    expect(r.unreadable).toBe(6)
  })

  it('ignores entries outside projects/<name>.json and writes nothing to disk', async () => {
    const path = writeZip([
      { name: '../evil.json', data: project('evil1') },
      { name: 'projects/a/b.json', data: project('evil2') },
      { name: '/abs.json', data: project('evil3') },
      { name: 'projects/../escape.json', data: project('evil4') },
      { name: 'projects\\back.json', data: project('evil5') },
      { name: 'a/b/projects/c.json', data: project('evil6') },
      { name: 'projects/c.txt', data: project('evil7') },
      { name: 'projects/', data: '' },
      { name: 'projects/real.json', data: project('real') },
    ])
    const before = readdirSync(dir).sort()
    const parentBefore = readdirSync(join(dir, '..')).sort()
    const r = await parseClaudeExport(path)
    expect(r).toMatchObject({ ok: true, unreadable: 0 })
    if (!r.ok) return
    expect(r.projects.map(p => p.uuid)).toEqual(['real'])
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(readdirSync(join(dir, '..')).filter(f => !parentBefore.includes(f) && /evil|escape|abs|back/.test(f))).toEqual([])
  })

  it('reads a zip re-made from the folder a Mac unzipped it into', async () => {
    const path = writeZip([
      { name: 'projects-000/', data: '' },
      { name: 'projects-000/projects/', data: '' },
      { name: 'projects-000/projects/mac.json', data: project('mac') },
      { name: '__MACOSX/projects-000/projects/._mac.json', data: 'resource fork' },
    ])
    const r = await parseClaudeExport(path)
    expect(r).toMatchObject({ ok: true, unreadable: 0 })
    if (!r.ok) return
    expect(r.projects.map(p => p.uuid)).toEqual(['mac'])
  })

  it('answers manifest for the download-links JSON', async () => {
    const path = join(dir, 'manifest.json')
    writeFileSync(path, JSON.stringify({ data_files: [{ category: 'projects', url: 'https://example.invalid/projects-000.zip' }] }))
    expect(await parseClaudeExport(path)).toEqual({ ok: false, code: 'manifest' })
    const padded = join(dir, 'manifest-padded.json')
    writeFileSync(padded, '﻿  \n' + JSON.stringify({ export_id: 'e', data_files: [] }))
    expect(await parseClaudeExport(padded)).toEqual({ ok: false, code: 'manifest' })
  })

  it('answers not_projects for a zip with only conversations.json, or another category', async () => {
    expect(await parseClaudeExport(writeZip([{ name: 'conversations.json', data: '[]' }]))).toEqual({ ok: false, code: 'not_projects' })
    expect(await parseClaudeExport(writeZip([{ name: 'memories/abc.json', data: '{}' }, { name: 'users.json', data: '[]' }]))).toEqual({ ok: false, code: 'not_projects' })
    expect(await parseClaudeExport(writeZip([]))).toEqual({ ok: false, code: 'not_projects' })
  })

  it('answers corrupt for random bytes, other JSON, a missing file and a truncated zip', async () => {
    const random = join(dir, 'random.bin')
    writeFileSync(random, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256)))
    expect(await parseClaudeExport(random)).toEqual({ ok: false, code: 'corrupt' })

    const json = join(dir, 'other.json')
    writeFileSync(json, JSON.stringify({ hello: 'world' }))
    expect(await parseClaudeExport(json)).toEqual({ ok: false, code: 'corrupt' })

    expect(await parseClaudeExport(join(dir, 'does-not-exist.zip'))).toEqual({ ok: false, code: 'corrupt' })

    const full = buildZip([{ name: 'projects/a.json', data: project('a') }])
    const cut = join(dir, 'cut.zip')
    writeFileSync(cut, full.subarray(0, full.length - 10))
    expect(await parseClaudeExport(cut)).toEqual({ ok: false, code: 'corrupt' })
  })

  it('answers too_large when an entry passes entryBytes', async () => {
    setZipLimitsForTest({ entryBytes: 1000 })
    const big = 'x'.repeat(2000)
    expect(await parseClaudeExport(writeZip([{ name: 'projects/big.json', data: JSON.stringify({ uuid: 'big', name: big }) }])))
      .toEqual({ ok: false, code: 'too_large' })
    // A declared size within the limit that inflates past it is refused, never read through.
    const lying = await parseClaudeExport(writeZip([{ name: 'projects/lie.json', data: JSON.stringify({ uuid: 'lie', name: big }), declaredSize: 100 }]))
    expect(lying).toEqual({ ok: false, code: 'corrupt' })
  })

  it('answers too_large when the read entries pass totalBytes', async () => {
    setZipLimitsForTest({ totalBytes: 3000 })
    const doc = 'y'.repeat(1200)
    const path = writeZip([
      { name: 'projects/a.json', data: project('a', { docs: [{ filename: 'a.md', content: doc }] }) },
      { name: 'projects/b.json', data: project('b', { docs: [{ filename: 'b.md', content: doc }] }) },
      { name: 'projects/c.json', data: project('c', { docs: [{ filename: 'c.md', content: doc }] }) },
    ])
    expect(await parseClaudeExport(path)).toEqual({ ok: false, code: 'too_large' })
  })

  it('answers too_large for more than entries entries', async () => {
    setZipLimitsForTest({ entries: 3 })
    const four = writeZip([1, 2, 3, 4].map(i => ({ name: `projects/p${i}.json`, data: project(`p${i}`) })))
    expect(await parseClaudeExport(four)).toEqual({ ok: false, code: 'too_large' })
    const three = writeZip([1, 2, 3].map(i => ({ name: `projects/p${i}.json`, data: project(`p${i}`) })))
    expect(await parseClaudeExport(three)).toMatchObject({ ok: true })
  })

  it('setZipLimitsForTest(null) restores the real limits', async () => {
    setZipLimitsForTest({ entries: 0 })
    const path = writeZip([{ name: 'projects/a.json', data: project('a') }])
    expect(await parseClaudeExport(path)).toEqual({ ok: false, code: 'too_large' })
    setZipLimitsForTest(null)
    expect(await parseClaudeExport(path)).toMatchObject({ ok: true })
    expect(ZIP_LIMITS).toEqual({ entries: 2000, entryBytes: 50 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 })
  })

  it('closes the zip on success, error and limit', async () => {
    const good = writeZip([{ name: 'projects/a.json', data: project('a') }, { name: 'projects/b.json', data: project('b') }])
    const broken = writeZip([{ name: 'projects/a.json', data: Buffer.from('not deflate data at all'), method: 0, declaredSize: 5 }])
    const bigOne = writeZip([{ name: 'projects/a.json', data: project('a') }, { name: 'projects/big.json', data: 'z'.repeat(5000) }])
    const cut = join(dir, 'cut-fd.zip')
    const full = buildZip([{ name: 'projects/a.json', data: project('a') }])
    writeFileSync(cut, full.subarray(0, full.length - 4))

    await parseClaudeExport(good)
    const start = openFds()
    for (let i = 0; i < 5; i++) {
      setZipLimitsForTest(null)
      expect((await parseClaudeExport(good)).ok).toBe(true)
      expect((await parseClaudeExport(broken)).ok).toBe(false)
      expect((await parseClaudeExport(cut)).ok).toBe(false)
      setZipLimitsForTest({ entryBytes: 1000 })
      expect(await parseClaudeExport(bigOne)).toEqual({ ok: false, code: 'too_large' })
    }
    // Give yauzl's deferred closes a tick to land.
    await new Promise(r => setTimeout(r, 50))
    expect(openFds()).toBeLessThanOrEqual(start)
  })
})

describe('isManifest', () => {
  it('is true only for a JSON object with a data_files array', () => {
    expect(isManifest(Buffer.from(JSON.stringify({ data_files: [] })))).toBe(true)
    expect(isManifest(Buffer.from('﻿' + JSON.stringify({ data_files: [{ url: 'x' }] })))).toBe(true)
    expect(isManifest(Buffer.from(JSON.stringify({ data_files: 'x' })))).toBe(false)
    expect(isManifest(Buffer.from(JSON.stringify([{ data_files: [] }])))).toBe(false)
    expect(isManifest(Buffer.from('null'))).toBe(false)
    expect(isManifest(Buffer.from('{"data_files": ['))).toBe(false)
    expect(isManifest(Buffer.from('PK\u0003\u0004'))).toBe(false)
  })
})
