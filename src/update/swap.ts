/**
 * File-tree swap for the updater: rename instead of delete-and-copy.
 *
 * The updater runs inside the very process it is updating, and that process
 * has native addons (better_sqlite3.node, keyring) mapped into memory from
 * node_modules. Windows refuses to unlink a mapped file, so the old
 * delete-then-copy swap failed with EPERM mid-update — and its rollback,
 * built from the same delete, failed on the identical lock (issue #27).
 *
 * What Windows does permit is renaming a mapped file (the trick Chrome's
 * updater is built on). So nothing here ever deletes live payload: the old
 * tree is moved aside into the backup dir, the new payload is moved into
 * place, and rollback is moving the backup straight back. Renames within a
 * volume are cheap and atomic per entry, so no path is ever half-copied.
 *
 * One Windows wrinkle shapes movePath: a mapped file blocks the rename of
 * every directory above it (you cannot rename a folder while an exe or DLL
 * inside it is running), even though the file itself renames fine. So when a
 * directory rename is refused, movePath recurses and moves the entries
 * individually — whole subtrees still go in one rename each, and only the
 * path down to a mapped file degrades to per-entry moves.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Injectable so tests can force the Windows and cross-device refusals. */
export type RenameFn = (src: string, dst: string) => void

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/**
 * Move src to dst. Merges into dst where dst is an existing directory
 * (rename cannot overwrite a directory on any platform); overwrites where
 * dst is an existing file. Falls back to copy+delete across volumes (EXDEV),
 * where no rename is possible and none of the mapped-file rules apply anyway.
 */
export function movePath(src: string, dst: string, rename: RenameFn = renameSync): void {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    rename(src, dst)
    return
  } catch (err) {
    if (errCode(err) === 'EXDEV') {
      cpSync(src, dst, { recursive: true, force: true })
      rmSync(src, { recursive: true, force: true })
      return
    }
    // lstat, not stat: a symlink to a directory must be renamed as a link,
    // never walked into.
    if (!lstatSync(src).isDirectory()) throw err
  }

  // Directory rename refused: dst already exists, or (Windows) something in
  // the tree is open/mapped. Merge entry by entry.
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    movePath(join(src, entry), join(dst, entry), rename)
  }
  // src is drained now. Removing the empty shell is best-effort: a process
  // sitting in it (cwd) can block this, and a leftover empty directory is
  // harmless because moves merge into existing directories.
  try {
    rmdirSync(src)
  } catch {}
}

/** Move each listed path that exists under root into backupDir. */
export function moveAside(root: string, backupDir: string, paths: string[], rename: RenameFn = renameSync): void {
  mkdirSync(backupDir, { recursive: true })
  for (const p of paths) {
    const live = join(root, p)
    if (existsSync(live)) movePath(live, join(backupDir, p), rename)
  }
}

/** Move each listed path that exists under fromDir into root. */
export function moveInto(fromDir: string, root: string, paths: string[], rename: RenameFn = renameSync): void {
  for (const p of paths) {
    const incoming = join(fromDir, p)
    if (existsSync(incoming)) movePath(incoming, join(root, p), rename)
  }
}

/**
 * Put the backup back after a failed swap. Which phase failed decides
 * clearTargets:
 *
 *   moveInto failed  → clearTargets true. Everything at the listed paths is
 *     freshly-arrived payload the process never loaded, so even Windows lets
 *     it go, and it must go: merging the backup over a partial payload would
 *     leave a mixed tree.
 *
 *   moveAside failed → clearTargets false. The listed paths still hold
 *     whatever the stash did not move — including, on Windows, the mapped
 *     file that refused to go. Deleting is both impossible and wrong; the
 *     merge below reassembles the original tree around what never left.
 */
export function restoreBackup(
  root: string,
  backupDir: string,
  paths: string[],
  opts: { clearTargets: boolean },
  rename: RenameFn = renameSync
): void {
  for (const p of paths) {
    const target = join(root, p)
    if (opts.clearTargets) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {}
    }
    const saved = join(backupDir, p)
    if (existsSync(saved)) movePath(saved, target, rename)
  }
}
