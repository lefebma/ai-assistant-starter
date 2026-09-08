import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listBackups, pruneBackups } from '../src/update/backups.js'
import { moveAside, restoreBackup } from '../src/update/swap.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP = mkdtempSync(join(tmpdir(), 'update-backups-'))
let fixtureCount = 0

function store(): string {
  const dir = join(TEMP, `store-${++fixtureCount}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A backup directory with one file in it, so an empty-dir shortcut cannot pass. */
function backup(storeDir: string, version: string, stamp: number): string {
  const dir = join(storeDir, `backup-v${version}-${stamp}`)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'VERSION'), version)
  return dir
}

function names(storeDir: string): string[] {
  return readdirSync(storeDir).sort()
}

afterAll(() => {
  try {
    rmSync(TEMP, { recursive: true, force: true })
  } catch {
    // a temp dir that outlives the run is not worth failing the suite over
  }
})

describe('listBackups', () => {
  it('finds only directories that match the backup naming pattern', () => {
    const s = store()
    backup(s, '1.22.1', 1788882785116)
    // Everything else in store/ is live state and must be invisible to this.
    writeFileSync(join(s, 'assistant.db'), 'sqlite')
    writeFileSync(join(s, 'hosted-status.json'), '{}')
    writeFileSync(join(s, 'backup-notes.txt'), 'not a backup dir')
    mkdirSync(join(s, 'update-temp'))
    mkdirSync(join(s, 'backup-of-something-else'))

    expect(listBackups(s).map((b) => b.name)).toEqual(['backup-v1.22.1-1788882785116'])
  })

  it('orders newest first by timestamp, not by name', () => {
    // The trap: sorted as strings, "backup-v1.9.0-..." lands after
    // "backup-v1.10.0-..." and the prune would delete the wrong one. The
    // trailing stamp is the only field that orders correctly.
    const s = store()
    backup(s, '1.10.0', 3000)
    backup(s, '1.9.0', 1000)
    backup(s, '1.20.0', 2000)

    expect(listBackups(s).map((b) => b.stamp)).toEqual([3000, 2000, 1000])
  })

  it('is empty, not broken, when the store directory does not exist', () => {
    expect(listBackups(join(TEMP, 'nothing-here'))).toEqual([])
  })
})

describe('pruneBackups', () => {
  it('keeps the two newest and removes the rest', () => {
    const s = store()
    backup(s, '1.20.0', 1000)
    backup(s, '1.21.0', 2000)
    backup(s, '1.22.0', 3000)
    backup(s, '1.23.0', 4000)

    const removed = pruneBackups(s)

    expect(removed.sort()).toEqual(['backup-v1.20.0-1000', 'backup-v1.21.0-2000'])
    expect(names(s)).toEqual(['backup-v1.22.0-3000', 'backup-v1.23.0-4000'])
  })

  it('does not touch the database, the temp dir, or anything else in store', () => {
    const s = store()
    backup(s, '1.20.0', 1000)
    backup(s, '1.21.0', 2000)
    backup(s, '1.22.0', 3000)
    writeFileSync(join(s, 'assistant.db'), 'sqlite')
    writeFileSync(join(s, 'assistant.db-wal'), 'wal')
    writeFileSync(join(s, 'hosted-status.json'), '{}')
    mkdirSync(join(s, 'update-temp'))
    writeFileSync(join(s, 'update-temp', 'payload.tar.gz'), 'x')

    pruneBackups(s)

    expect(readFileSync(join(s, 'assistant.db'), 'utf-8')).toBe('sqlite')
    expect(existsSync(join(s, 'assistant.db-wal'))).toBe(true)
    expect(existsSync(join(s, 'hosted-status.json'))).toBe(true)
    expect(existsSync(join(s, 'update-temp', 'payload.tar.gz'))).toBe(true)
  })

  it('does nothing when there is nothing to spare', () => {
    const s = store()
    backup(s, '1.23.0', 4000)
    expect(pruneBackups(s)).toEqual([])
    expect(names(s)).toEqual(['backup-v1.23.0-4000'])
  })

  it('honours a different keep count', () => {
    const s = store()
    for (const [v, stamp] of [['1.20.0', 1000], ['1.21.0', 2000], ['1.22.0', 3000]] as const) {
      backup(s, v, stamp)
    }
    pruneBackups(s, 1)
    expect(names(s)).toEqual(['backup-v1.22.0-3000'])
  })

  it('will not be talked into deleting every backup', () => {
    // keep: 0 would leave an operator with nothing to hand-roll back to, which
    // is not a state any config should be able to ask for.
    const s = store()
    backup(s, '1.22.0', 3000)
    backup(s, '1.23.0', 4000)
    pruneBackups(s, 0)
    expect(names(s)).toEqual(['backup-v1.23.0-4000'])
  })

  it('survives a directory it cannot remove, and still removes the others', () => {
    // A prune failure must never turn a successful update into a failed one.
    const s = store()
    backup(s, '1.20.0', 1000)
    backup(s, '1.21.0', 2000)
    backup(s, '1.22.0', 3000)
    backup(s, '1.23.0', 4000)

    const removed = pruneBackups(s, 2, {
      remove: (path: string) => {
        if (path.endsWith('backup-v1.20.0-1000')) throw new Error('EBUSY')
        rmSync(path, { recursive: true, force: true })
      },
    })

    expect(removed).toEqual(['backup-v1.21.0-2000'])
    expect(existsSync(join(s, 'backup-v1.20.0-1000'))).toBe(true)
    expect(existsSync(join(s, 'backup-v1.21.0-2000'))).toBe(false)
  })

  it('returns empty rather than throwing when the store is unreadable', () => {
    expect(pruneBackups(join(TEMP, 'also-not-here'))).toEqual([])
  })
})

describe('pruning and rollback together', () => {
  it('leaves the backup this update just made, so a rollback still has one', () => {
    // The scenario the card is really guarding: prune runs, then something
    // later in the update throws, and restoreBackup has to find the dir it
    // was given. Pruning oldest-first with keep >= 1 means the newest, which
    // is always the one this run created, is never a candidate.
    const s = store()
    const payload = join(TEMP, `payload-${++fixtureCount}`)
    mkdirSync(join(payload, 'dist'), { recursive: true })
    writeFileSync(join(payload, 'dist', 'index.js'), 'the old build')

    backup(s, '1.19.0', 1000)
    backup(s, '1.20.0', 2000)

    const mine = join(s, 'backup-v1.23.0-9999')
    moveAside(payload, mine, ['dist'])
    expect(existsSync(join(payload, 'dist'))).toBe(false)

    pruneBackups(s)

    expect(existsSync(mine)).toBe(true)
    restoreBackup(payload, mine, ['dist'], { clearTargets: false })
    expect(readFileSync(join(payload, 'dist', 'index.js'), 'utf-8')).toBe('the old build')
  })
})

/** Each `catch (...) { ... }` body in a source file, matched by counting braces. */
function catchBodies(source: string): string[] {
  const bodies: string[] = []
  const opener = /\}?\s*catch\s*(?:\([^)]*\))?\s*\{/g
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    const start = m.index + m[0].length
    let depth = 1
    let i = start
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
      i++
    }
    bodies.push(source.slice(start, i - 1))
  }
  return bodies
}

describe('where the updater calls it', () => {
  const updater = readFileSync(resolve(ROOT, 'src/updater.ts'), 'utf-8')

  it('prunes on both update paths', () => {
    expect(updater.match(/pruneBackups\(/g)?.length).toBe(2)
  })

  it('never prunes from a catch block', () => {
    // Pruning while rolling back could delete the directory the rollback is
    // reading from. Both call sites must sit on the success path, before the
    // return and after the swap. This is a structural guard against someone
    // later moving the call into a catch or a finally for tidiness.
    //
    // Brace-counted rather than split on a closing line: the handlers here are
    // nested and indented, so "find the next }" reads far past the end of the
    // short ones and swallows code that is not in a catch at all.
    for (const body of catchBodies(updater)) {
      expect(body).not.toContain('pruneBackups')
    }
  })

  it('finds the catch blocks it claims to be checking', () => {
    // Guards the guard. If catchBodies stopped matching, the test above would
    // pass on an empty list and prove nothing.
    const bodies = catchBodies(updater)
    expect(bodies.length).toBeGreaterThanOrEqual(4)
    expect(bodies.some((b) => b.includes('Rollback also failed'))).toBe(true)
  })
})
