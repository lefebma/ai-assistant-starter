/**
 * Card #284: read-only Drive access through gog. A fake `run` records the
 * arguments and environment, so no real binary or Google call is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listFolder, getFile, fetchFile, driveAccounts, driveConnectMode, DriveFailure,
  MAX_DRIVE_BYTES, AUTH_LIST_ARGS, DRIVE_ID, PAGE_SIZE, GOOGLE_EXPORT_PDF, type DriveDeps,
} from '../src/web/drive.js'

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

type Call = { args: string[]; env: Record<string, string> }
let tmpDir: string
let calls: Call[]
let run: ReturnType<typeof vi.fn>
let stdout: string
let keeper: { accounts: () => { account: string; state: 'ok' | 'reconnect' }[]; token: (a: string) => Promise<string | null> }

const doc = { id: 'd1', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-01T10:00:00Z' }
const folder = { id: 'f1', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' }
const listOut = (files: unknown[], next?: string) => JSON.stringify({ files, ...(next ? { nextPageToken: next } : {}) })

function mkDeps(over: Partial<DriveDeps> = {}): DriveDeps {
  return {
    run: run as unknown as DriveDeps['run'],
    keeper: keeper as unknown as DriveDeps['keeper'],
    relayConfigured: true,
    gogInstalled: () => true,
    gogAccounts: async () => [],
    tmpDir,
    now: () => Date.now(),
    ...over,
  }
}
const last = () => calls[calls.length - 1]!

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'drive-test-'))
  calls = []
  stdout = listOut([doc, folder])
  keeper = { accounts: () => [{ account: 'm@x.com', state: 'ok' }], token: async () => 'TOKEN-1' }
  run = vi.fn(async (args: string[], env: Record<string, string>) => {
    calls.push({ args, env })
    return { code: 0, stdout }
  })
})
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

describe('constants', () => {
  it('match the brief', () => {
    expect(MAX_DRIVE_BYTES).toBe(25 * 1024 * 1024)
    expect(PAGE_SIZE).toBe(100)
    expect(DRIVE_ID.test('abc_-123')).toBe(true)
    expect(GOOGLE_EXPORT_PDF.size).toBe(3)
  })
})

describe('listFolder', () => {
  it('lists a folder read only, My Drive only, with the token in the environment not the arguments', async () => {
    await listFolder('m@x.com', 'root', undefined, mkDeps())
    expect(last().args).toEqual(expect.arrayContaining(['drive', 'ls', '--json', '--readonly', '--parent=root', '--max', '100', '--no-all-drives']))
    expect(last().args).toEqual(expect.arrayContaining(['--enable-commands-exact', 'drive.ls']))
    expect(last().args).not.toContain('--results-only')
    expect(last().args.join(' ')).not.toContain('TOKEN-1')
    expect(last().env.GOG_ACCESS_TOKEN).toBe('TOKEN-1')
    expect(last().args).not.toContain('--account')
  })

  it('passes the page token through as --page', async () => {
    await listFolder('m@x.com', 'root', 'P1', mkDeps())
    expect(last().args).toEqual(expect.arrayContaining(['--page=P1']))
  })

  it('a gog-signed account is named with --account and gets no token', async () => {
    const deps = mkDeps({ relayConfigured: false, gogAccounts: async () => [{ account: 'm@x.com', services: ['drive', 'gmail'] }] })
    await listFolder('m@x.com', 'root', undefined, deps)
    expect(last().args).toEqual(expect.arrayContaining(['--account', 'm@x.com']))
    expect(last().env.GOG_ACCESS_TOKEN).toBeUndefined()
  })

  it('maps entries, folders first, and passes the next page token through', async () => {
    stdout = listOut([doc, folder], 'P2')
    const r = await listFolder('m@x.com', 'root', undefined, mkDeps())
    expect(r.entries.map((e) => e.name)).toEqual(['Folder', 'Doc'])
    expect(r.entries[0]!.isDir).toBe(true)
    expect(r.entries[1]).toMatchObject({ id: 'd1', isDir: false, modified: '2026-11-01T10:00:00Z' })
    expect(r.nextPage).toBe('P2')
  })

  it('sorts by name case-insensitively and reads a string size', async () => {
    stdout = listOut([
      { id: 'b', name: 'beta', mimeType: 'text/plain', size: '12' },
      { id: 'a', name: 'Alpha', mimeType: 'text/plain', size: 7 },
    ])
    const r = await listFolder('m@x.com', 'root', undefined, mkDeps())
    expect(r.entries.map((e) => [e.name, e.size])).toEqual([['Alpha', 7], ['beta', 12]])
  })

  it('an empty folder is an empty list with no next page', async () => {
    stdout = listOut([])
    expect(await listFolder('m@x.com', 'root', undefined, mkDeps())).toEqual({ entries: [], nextPage: null })
  })

  it('leaves trashed files out', async () => {
    stdout = listOut([{ ...doc, trashed: true }, folder])
    const r = await listFolder('m@x.com', 'root', undefined, mkDeps())
    expect(r.entries.map((e) => e.name)).toEqual(['Folder'])
  })

  it('drops rows with no id and tolerates a missing file list', async () => {
    stdout = listOut([{ name: 'no id', mimeType: 'text/plain' }])
    expect((await listFolder('m@x.com', 'root', undefined, mkDeps())).entries).toEqual([])
    stdout = '{}'
    expect(await listFolder('m@x.com', 'root', undefined, mkDeps())).toEqual({ entries: [], nextPage: null })
  })

  it.each(['../x', 'a b', '', 'x'.repeat(129), 'id;rm'])('refuses folder id %j before gog runs', async (id) => {
    await expect(listFolder('m@x.com', id, undefined, mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['-aauto', '--all', '-'])('refuses option-shaped folder id %j before gog runs', async (id) => {
    await expect(listFolder('m@x.com', id, undefined, mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['--all', 'a b', '', 'x'.repeat(2049), '-x', 'a;b'])('refuses page token %j before gog runs', async (tok) => {
    await expect(listFolder('m@x.com', 'root', tok, mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    expect(run).not.toHaveBeenCalled()
  })

  it('accepts a realistic page token', async () => {
    await listFolder('m@x.com', 'root', 'ABC_d-e=f.g~h+i/j', mkDeps())
    expect(last().args).toContain('--page=ABC_d-e=f.g~h+i/j')
  })

  it('gog exit code 4 (documented: auth) answers reconnect for every call', async () => {
    run.mockImplementation(async () => ({ code: 4, stdout: '' }))
    await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'reconnect' })
    await expect(getFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'reconnect' })
  })

  it('lists gog accounts read only and limited to auth.list', () => {
    expect(AUTH_LIST_ARGS).toEqual(['auth', 'list', '--plain', '--readonly', '--enable-commands-exact', 'auth.list'])
  })

  it('refuses an account that has no Drive connection', async () => {
    await expect(listFolder('other@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'not_connected' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a revoked or missing token answers reconnect', async () => {
    keeper = { accounts: () => [{ account: 'm@x.com', state: 'reconnect' }], token: async () => null }
    await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'reconnect' })
    keeper = { accounts: () => [{ account: 'm@x.com', state: 'ok' }], token: async () => null }
    await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'reconnect' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a timeout, a missing gog and a non-zero exit all answer unavailable', async () => {
    for (const fail of [
      () => Promise.reject(Object.assign(new Error('timed out'), { killed: true })),
      () => Promise.reject(Object.assign(new Error('spawn gog ENOENT'), { code: 'ENOENT' })),
      () => Promise.resolve({ code: 1, stdout: '' }),
    ]) {
      run.mockImplementationOnce(fail)
      await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'unavailable' })
    }
  })

  it('unparseable output answers unavailable', async () => {
    stdout = 'not json'
    await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('getFile', () => {
  it('reads one file read only and unwraps an envelope', async () => {
    stdout = JSON.stringify({ file: { id: 'abc', name: 'Plan', mimeType: 'application/pdf', size: '99' } })
    const f = await getFile('m@x.com', 'abc', mkDeps())
    expect(f).toMatchObject({ id: 'abc', name: 'Plan', size: 99, isDir: false })
    expect(last().args).toEqual(expect.arrayContaining(['drive', 'get', '--json', '--readonly', '--enable-commands-exact', 'drive.get', '--', 'abc']))
  })

  it('a trashed file is not found', async () => {
    stdout = JSON.stringify({ id: 'abc', name: 'x', mimeType: 'text/plain', trashed: true })
    await expect(getFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'not_found' })
  })

  it('gog exit code 5 (documented: not found) answers not_found, other failures stay unavailable', async () => {
    run.mockImplementationOnce(async () => ({ code: 5, stdout: '' }))
    await expect(getFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    for (const code of [1, 7]) {
      run.mockImplementationOnce(async () => ({ code, stdout: '' }))
      await expect(getFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'unavailable' })
    }
  })

  it.each(['-aauto', '--all', '-'])('refuses option-shaped id %j before gog runs', async (id) => {
    await expect(getFile('m@x.com', id, mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    await expect(fetchFile('m@x.com', id, mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a bad id', async () => {
    await expect(getFile('m@x.com', 'a/b', mkDeps())).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('fetchFile', () => {
  const fakeDownload = (bytes = 'data') =>
    run.mockImplementation(async (args: string[], env: Record<string, string>) => {
      calls.push({ args, env })
      if (args.includes('download')) {
        writeFileSync(args[args.indexOf('--out') + 1]!, bytes)
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout }
    })

  it('exports a Google Doc as a PDF with a safe name', async () => {
    stdout = JSON.stringify({ id: 'abc', name: 'Q4 "plan"/draft', mimeType: 'application/vnd.google-apps.document' })
    fakeDownload()
    const f = await fetchFile('m@x.com', 'abc', mkDeps())
    const dl = calls.find((c) => c.args.includes('download'))!
    expect(dl.args).toEqual(expect.arrayContaining(['drive', 'download', '--json', '--format', 'pdf', '--out', f.path, '--readonly', '--enable-commands-exact', 'drive.download', '--', 'abc']))
    expect(f.name).toBe('Q4 _plan__draft.pdf')
    expect(f.mimeType).toBe('application/pdf')
    expect(f.path.startsWith(tmpDir)).toBe(true)
    expect(existsSync(f.path)).toBe(true)
  })

  it('downloads a regular file without --format and keeps its type', async () => {
    stdout = JSON.stringify({ id: 'abc', name: 'a.png', mimeType: 'image/png', size: 10 })
    fakeDownload()
    const f = await fetchFile('m@x.com', 'abc', mkDeps())
    expect(calls.find((c) => c.args.includes('download'))!.args).not.toContain('--format')
    expect(f).toMatchObject({ name: 'a.png', mimeType: 'image/png' })
  })

  it('refuses a file over 25 MB before downloading', async () => {
    stdout = JSON.stringify({ id: 'abc', name: 'big.bin', mimeType: 'application/zip', size: String(MAX_DRIVE_BYTES + 1) })
    await expect(fetchFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'too_large' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['application/vnd.google-apps.folder'],
    ['application/vnd.google-apps.form'],
    ['application/vnd.google-apps.shortcut'],
  ])('%s has nothing to fetch', async (mimeType) => {
    stdout = JSON.stringify({ id: 'abc', name: 'x', mimeType })
    await expect(fetchFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'not_found' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cleanup removes the temp file, and a failed download leaves none behind', async () => {
    stdout = JSON.stringify({ id: 'abc', name: 'a.txt', mimeType: 'text/plain', size: 4 })
    fakeDownload()
    const f = await fetchFile('m@x.com', 'abc', mkDeps())
    f.cleanup()
    expect(existsSync(f.path)).toBe(false)
    f.cleanup() // twice is fine

    run.mockImplementation(async (args: string[]) => {
      if (args.includes('download')) {
        writeFileSync(args[args.indexOf('--out') + 1]!, 'partial')
        return { code: 1, stdout: '' }
      }
      return { code: 0, stdout }
    })
    await expect(fetchFile('m@x.com', 'abc', mkDeps())).rejects.toMatchObject({ code: 'unavailable' })
    expect(readdirSync(tmpDir)).toEqual([])
  })

  it('sweeps temp files older than ten minutes on each fetch', async () => {
    const old = join(tmpDir, 'old'), fresh = join(tmpDir, 'fresh')
    writeFileSync(old, 'x'); writeFileSync(fresh, 'x')
    const t = Date.now()
    utimesSync(old, new Date(t - 11 * 60_000), new Date(t - 11 * 60_000))
    utimesSync(fresh, new Date(t - 5 * 60_000), new Date(t - 5 * 60_000))
    stdout = JSON.stringify({ id: 'abc', name: 'a.txt', mimeType: 'text/plain', size: 4 })
    fakeDownload()
    await fetchFile('m@x.com', 'abc', mkDeps({ now: () => t }))
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('concurrency', () => {
  it('runs at most two gog calls at once', async () => {
    let inFlight = 0, peak = 0
    const releases: (() => void)[] = []
    run.mockImplementation(() => {
      inFlight++; peak = Math.max(peak, inFlight)
      return new Promise((res) => releases.push(() => { inFlight--; res({ code: 0, stdout: listOut([]) }) }))
    })
    const ps = [1, 2, 3].map(() => listFolder('m@x.com', 'root', undefined, mkDeps()))
    await vi.waitFor(() => expect(releases.length).toBe(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(releases.length).toBe(2)
    releases[0]!()
    await vi.waitFor(() => expect(releases.length).toBe(3))
    releases[1]!(); releases[2]!()
    await Promise.all(ps)
    expect(peak).toBe(2)
  })

  it('a failed call frees its place', async () => {
    run.mockRejectedValue(new Error('boom'))
    for (let i = 0; i < 4; i++) await expect(listFolder('m@x.com', 'root', undefined, mkDeps())).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('accounts and mode', () => {
  it('on a relay box only relay-connected accounts are listed, gog sign-ins are ignored', async () => {
    expect(await driveAccounts(mkDeps({ relayConfigured: true, gogAccounts: async () => [{ account: 'other@x.com', services: ['drive'] }] })))
      .toEqual([{ account: 'm@x.com', state: 'ok' }])
  })

  it('without the relay, gog accounts whose services include drive are listed', async () => {
    const deps = mkDeps({
      relayConfigured: false,
      gogAccounts: async () => [
        { account: 'a@x.com', services: ['gmail', 'calendar'] },
        { account: 'b@x.com', services: ['Drive'] },
      ],
    })
    expect(await driveAccounts(deps)).toEqual([{ account: 'b@x.com', state: 'ok' }])
  })

  it('a gog listing failure means no accounts', async () => {
    expect(await driveAccounts(mkDeps({ relayConfigured: false, gogAccounts: async () => { throw new Error('x') } }))).toEqual([])
  })

  it('names the connect mode', () => {
    expect(driveConnectMode(mkDeps({ relayConfigured: true }))).toBe('relay')
    expect(driveConnectMode(mkDeps({ relayConfigured: true, gogInstalled: () => false }))).toBe('relay')
    expect(driveConnectMode(mkDeps({ relayConfigured: false, gogInstalled: () => true }))).toBe('gog')
    expect(driveConnectMode(mkDeps({ relayConfigured: false, gogInstalled: () => false }))).toBeNull()
  })

  it('with neither a relay nor gog there are no accounts and gog is never asked', async () => {
    const gogAccounts = vi.fn(async () => [{ account: 'a@x.com', services: ['drive'] }])
    expect(await driveAccounts(mkDeps({ relayConfigured: false, gogInstalled: () => false, gogAccounts }))).toEqual([])
    expect(gogAccounts).not.toHaveBeenCalled()
  })
})
