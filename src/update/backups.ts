/**
 * Housekeeping for the backup directories `/update` leaves behind.
 *
 * Every update renames the old payload into `store/backup-vVERSION-STAMP`
 * rather than deleting it, because this process still has native addons mapped
 * out of node_modules and Windows will not unlink those (see swap.ts). Nothing
 * ever removed them, so they accumulated for the life of the install.
 *
 * On a source install that is small change: the engine paths are src, scripts,
 * public and templates, about 1.5 MB a time. On a bundle install the payload
 * includes node_modules, which is around 400 MB, so ten updates is 4 GB of
 * dead weight on a box with a 40 GB disk. Bundle installs are what a client
 * gets from a release tarball, so that is the case this exists for.
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'

/**
 * `backup-v` + a version + `-` + an epoch-millis stamp. The version is matched
 * loosely on purpose (prereleases and build metadata contain dashes); the
 * stamp is the greedy-safe part, anchored to the end.
 */
const BACKUP_DIR = /^backup-v.+-(\d+)$/

export interface Backup {
  name: string
  path: string
  stamp: number
}

/** Never delete every backup, whatever the caller asks for. */
const MIN_KEEP = 1

export interface PruneDeps {
  remove?: (path: string) => void
}

/**
 * The backup directories in a store, newest first.
 *
 * Ordered by the trailing timestamp rather than by name or mtime. By name is
 * wrong because string order puts v1.9.0 after v1.10.0, which would prune the
 * newest backup and keep an ancient one. By mtime is wrong because a rollback
 * touches the directory it restores from, which would reorder history to
 * whichever backup was most recently *read*.
 *
 * Returns an empty list rather than throwing: a store that cannot be read is
 * a problem for the caller's real work, not for its housekeeping.
 */
export function listBackups(storeDir: string): Backup[] {
  let entries: string[]
  try {
    entries = readdirSync(storeDir)
  } catch {
    return []
  }

  const found: Backup[] = []
  for (const name of entries) {
    const match = BACKUP_DIR.exec(name)
    if (!match) continue
    const path = join(storeDir, name)
    try {
      // Everything else in store/ is live state: the SQLite database and its
      // -wal/-shm siblings, hosted-status.json, update-temp. A file that
      // happens to match the pattern is still not a backup.
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    found.push({ name, path, stamp: Number(match[1]) })
  }

  return found.sort((a, b) => b.stamp - a.stamp)
}

/**
 * Remove all but the newest `keep` backups. Returns the names removed.
 *
 * Call this only after a swap has succeeded. Pruning while rolling back could
 * delete the directory the rollback is reading from; pruning oldest-first with
 * keep >= 1 also means the backup the current run just created is never a
 * candidate, since it is always the newest.
 *
 * Never throws. A box that cannot delete an old directory (Windows holding a
 * handle, a permissions oddity) still had a successful update, and reporting
 * it as a failure would send someone rolling back a good release.
 */
export function pruneBackups(storeDir: string, keep = 2, deps: PruneDeps = {}): string[] {
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }))
  const stale = listBackups(storeDir).slice(Math.max(MIN_KEEP, keep))
  const removed: string[] = []

  for (const backup of stale) {
    try {
      remove(backup.path)
      removed.push(backup.name)
    } catch (err) {
      logger.warn({ err, backup: backup.name }, 'Could not remove old update backup')
    }
  }

  if (removed.length > 0) {
    logger.info({ removed, kept: Math.max(MIN_KEEP, keep) }, 'Pruned old update backups')
  }
  return removed
}
