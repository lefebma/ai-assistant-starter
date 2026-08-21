import { describe, it, expect, afterAll } from 'vitest'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { movePath, moveAside, moveInto, restoreBackup } from '../src/update/swap.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every fixture lives under one temp root so cleanup is a single rm. */
const TEMP = mkdtempSync(join(tmpdir(), 'update-swap-'))
let fixtureCount = 0
function fixture(): string {
  const dir = join(TEMP, `f${fixtureCount++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

/** All file paths (relative, sorted) under a directory — tree equality checks. */
function treeFiles(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...treeFiles(root, rel))
    else out.push(rel)
  }
  return out
}

afterAll(() => {
  // On Windows the dlopen fixture below stays mapped until the test process
  // exits, so this cleanup can be refused. The OS temp dir owns the leftovers.
  try {
    rmSync(TEMP, { recursive: true, force: true })
  } catch {}
})

describe('movePath', () => {
  it('moves a file, creating destination parents', () => {
    const dir = fixture()
    write(dir, 'a/one.txt', 'one')
    movePath(join(dir, 'a/one.txt'), join(dir, 'deep/ly/nested/one.txt'))
    expect(read(dir, 'deep/ly/nested/one.txt')).toBe('one')
    expect(existsSync(join(dir, 'a/one.txt'))).toBe(false)
  })

  it('moves a whole tree in one rename', () => {
    const dir = fixture()
    write(dir, 'src/pkg/index.js', 'x')
    write(dir, 'src/pkg/build/native.node', 'binary')
    movePath(join(dir, 'src'), join(dir, 'dst'))
    expect(treeFiles(join(dir, 'dst'))).toEqual(['pkg/build/native.node', 'pkg/index.js'])
    expect(existsSync(join(dir, 'src'))).toBe(false)
  })

  it('merges into an existing directory, overwriting files but keeping strangers', () => {
    const dir = fixture()
    write(dir, 'incoming/mod/a.js', 'new-a')
    write(dir, 'incoming/mod/c.js', 'new-c')
    write(dir, 'live/mod/a.js', 'old-a')
    write(dir, 'live/mod/b.js', 'old-b')
    movePath(join(dir, 'incoming'), join(dir, 'live'))
    expect(read(dir, 'live/mod/a.js')).toBe('new-a')
    expect(read(dir, 'live/mod/b.js')).toBe('old-b')
    expect(read(dir, 'live/mod/c.js')).toBe('new-c')
  })

  it('moves a symlink as a link instead of walking through it', () => {
    const dir = fixture()
    write(dir, 'real/target.js', 'target')
    mkdirSync(join(dir, 'src'))
    try {
      symlinkSync(join(dir, 'real'), join(dir, 'src/link'))
    } catch {
      return // symlink creation needs privileges on some Windows setups; nothing to test then
    }
    // dst dir exists so the top-level rename refuses and recursion handles the link
    mkdirSync(join(dir, 'dst'))
    write(dir, 'dst/keep.txt', 'keep')
    movePath(join(dir, 'src'), join(dir, 'dst'))
    expect(lstatSync(join(dir, 'dst/link')).isSymbolicLink()).toBe(true)
    expect(read(dir, 'real/target.js')).toBe('target')
  })

  it('falls back to per-entry moves when directory renames are refused (Windows mapped-file rule)', () => {
    // Simulate Windows: a directory containing an open/mapped file cannot be
    // renamed, but the files themselves can.
    const windowsRename = (src: string, dst: string): void => {
      if (lstatSync(src).isDirectory()) {
        const err = new Error(`EPERM: operation not permitted, rename '${src}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      renameSync(src, dst)
    }
    const dir = fixture()
    write(dir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'mapped')
    write(dir, 'node_modules/better-sqlite3/lib/index.js', 'js')
    write(dir, 'node_modules/pino/pino.js', 'pino')
    movePath(join(dir, 'node_modules'), join(dir, 'backup/node_modules'), windowsRename)
    expect(treeFiles(join(dir, 'backup/node_modules'))).toEqual([
      'better-sqlite3/build/Release/better_sqlite3.node',
      'better-sqlite3/lib/index.js',
      'pino/pino.js',
    ])
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  })

  it('surfaces the error when a file itself refuses to move', () => {
    const stuck = join('build', 'stuck.node')
    const rename = (src: string, dst: string): void => {
      if (src.endsWith(stuck) || lstatSync(src).isDirectory()) {
        const err = new Error(`EBUSY: resource busy, rename '${src}'`) as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      }
      renameSync(src, dst)
    }
    const dir = fixture()
    write(dir, `pkg/${stuck}`, 'x')
    expect(() => movePath(join(dir, 'pkg'), join(dir, 'out'), rename)).toThrow(/EBUSY/)
  })

  it('copies across volumes when rename answers EXDEV', () => {
    const exdev = (): void => {
      const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
      err.code = 'EXDEV'
      throw err
    }
    const dir = fixture()
    write(dir, 'src/pkg/a.js', 'a')
    write(dir, 'src/pkg/deep/b.js', 'b')
    movePath(join(dir, 'src'), join(dir, 'other-volume/src'), exdev)
    expect(treeFiles(join(dir, 'other-volume/src'))).toEqual(['pkg/a.js', 'pkg/deep/b.js'])
    expect(existsSync(join(dir, 'src'))).toBe(false)
  })
})

describe('moveAside + moveInto (the update swap)', () => {
  const PATHS = ['dist', 'node_modules', 'VERSION']

  function installFixture(): { root: string; payload: string; backup: string } {
    const dir = fixture()
    const root = join(dir, 'install')
    const payload = join(dir, 'payload')
    const backup = join(root, 'store', 'backup')
    write(root, 'dist/src/index.js', 'old-app')
    write(root, 'node_modules/better-sqlite3/build/native.node', 'old-native')
    write(root, 'VERSION', '1.14.2')
    write(root, '.env', 'SECRET=1') // preserved: not on the swap list
    write(root, 'store/assistant.db', 'data')
    write(payload, 'dist/src/index.js', 'new-app')
    write(payload, 'node_modules/better-sqlite3/build/native.node', 'new-native')
    write(payload, 'VERSION', '1.16.0')
    return { root, payload, backup }
  }

  it('swaps the payload in and parks the old tree in the backup', () => {
    const { root, payload, backup } = installFixture()
    moveAside(root, backup, PATHS)
    moveInto(payload, root, PATHS)
    expect(read(root, 'VERSION')).toBe('1.16.0')
    expect(read(root, 'dist/src/index.js')).toBe('new-app')
    expect(read(root, 'node_modules/better-sqlite3/build/native.node')).toBe('new-native')
    expect(read(backup, 'VERSION')).toBe('1.14.2')
    expect(read(backup, 'node_modules/better-sqlite3/build/native.node')).toBe('old-native')
  })

  it('leaves preserved paths untouched', () => {
    const { root, payload, backup } = installFixture()
    moveAside(root, backup, PATHS)
    moveInto(payload, root, PATHS)
    expect(read(root, '.env')).toBe('SECRET=1')
    expect(read(root, 'store/assistant.db')).toBe('data')
  })

  it('skips listed paths that do not exist on either side', () => {
    const { root, payload, backup } = installFixture()
    rmSync(join(root, 'dist'), { recursive: true })
    rmSync(join(payload, 'node_modules'), { recursive: true })
    moveAside(root, backup, PATHS)
    moveInto(payload, root, PATHS)
    expect(read(root, 'dist/src/index.js')).toBe('new-app')
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  })
})

describe('restoreBackup', () => {
  const PATHS = ['dist', 'node_modules', 'VERSION']

  it('after a failed apply: clears the partial payload and restores the old tree exactly', () => {
    const dir = fixture()
    const root = join(dir, 'install')
    const backup = join(dir, 'backup')
    // The stash completed (backup holds the whole old tree), then the apply
    // died partway: dist landed, node_modules is half-arrived, VERSION never came.
    write(backup, 'dist/src/index.js', 'old-app')
    write(backup, 'node_modules/pkg/index.js', 'old-pkg')
    write(backup, 'VERSION', '1.14.2')
    mkdirSync(root, { recursive: true })
    write(root, 'dist/src/index.js', 'new-app')
    write(root, 'dist/src/new-module.js', 'straggler')
    write(root, 'node_modules/pkg/index.js', 'new-pkg')
    restoreBackup(root, backup, PATHS, { clearTargets: true })
    expect(read(root, 'dist/src/index.js')).toBe('old-app')
    expect(read(root, 'node_modules/pkg/index.js')).toBe('old-pkg')
    expect(read(root, 'VERSION')).toBe('1.14.2')
    // A stale new file merged into an old tree is the half-applied state the
    // issue warned about; clearTargets exists to prevent exactly this.
    expect(existsSync(join(root, 'dist/src/new-module.js'))).toBe(false)
  })

  it('after a failed stash: reassembles the old tree around what never left', () => {
    const dir = fixture()
    const root = join(dir, 'install')
    const backup = join(dir, 'backup')
    // The stash died partway through node_modules: pino moved, the mapped
    // addon refused and is still live in root. Nothing new arrived.
    write(root, 'node_modules/better-sqlite3/build/native.node', 'mapped-old')
    write(backup, 'node_modules/pino/pino.js', 'old-pino')
    write(backup, 'dist/src/index.js', 'old-app')
    restoreBackup(root, backup, PATHS, { clearTargets: false })
    expect(read(root, 'node_modules/better-sqlite3/build/native.node')).toBe('mapped-old')
    expect(read(root, 'node_modules/pino/pino.js')).toBe('old-pino')
    expect(read(root, 'dist/src/index.js')).toBe('old-app')
  })
})

// ── The real thing: a genuinely memory-mapped native addon ──
//
// Everything above simulates the Windows refusals; this loads an actual .node
// file so the OS itself enforces them. On Windows CI this is the live repro of
// issue #27: unlink of a mapped addon fails, yet the rename-based swap moves
// it. On macOS/Linux the same swap runs without needing any fallback. The
// mapping cannot be undone from JS, so these fixtures stay mapped (and on
// Windows undeletable) until the test process exits — see the afterAll above.

const ADDON = join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')

function dlopenCopy(dir: string, rel: string): boolean {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  cpSync(ADDON, p)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process as any).dlopen({ exports: {} }, p)
    return true
  } catch {
    return false // not loadable in this environment; the test degrades to skip
  }
}

describe.runIf(existsSync(ADDON))('with a real mapped native addon', () => {
  it.runIf(process.platform === 'win32')('issue #27 repro: the mapped addon cannot be unlinked', () => {
    const dir = fixture()
    if (!dlopenCopy(dir, 'node_modules/pkg/build/addon.node')) return
    expect(() => rmSync(join(dir, 'node_modules'), { recursive: true, force: true })).toThrow()
  })

  it('the rename-based swap moves the mapped addon anyway', () => {
    const dir = fixture()
    if (!dlopenCopy(dir, 'root/node_modules/pkg/build/addon.node')) return
    write(dir, 'root/node_modules/pkg/index.js', 'js')
    write(dir, 'payload/node_modules/pkg/build/addon.node', 'new-native')
    write(dir, 'payload/node_modules/pkg/index.js', 'new-js')
    const root = join(dir, 'root')
    const backup = join(dir, 'backup')
    moveAside(root, backup, ['node_modules'])
    moveInto(join(dir, 'payload'), root, ['node_modules'])
    // The mapped file is intact in the backup and the new payload is live.
    expect(existsSync(join(backup, 'node_modules/pkg/build/addon.node'))).toBe(true)
    expect(read(backup, 'node_modules/pkg/index.js')).toBe('js')
    expect(read(root, 'node_modules/pkg/build/addon.node')).toBe('new-native')
    expect(read(root, 'node_modules/pkg/index.js')).toBe('new-js')
  })
})
