/**
 * Where the tool-guard and role logs live (card #237, from spike #218 defect 5).
 *
 * They used to sit in store/, inside the install, where the assistant's own
 * shell could delete them. Now they go in the audit store whenever auditing is
 * on (it is on by default, see AUDIT_DIR in config.ts):
 *   - the audit store is outside the install, and every tool call that would
 *     touch it is refused before it runs, whatever TOOL_GUARD says
 *     (audit-trail.ts, storeTouch);
 *   - on a hosted box root creates both files with the append-only flag
 *     (cloud-init, enable-audit), so even a shell that got past the refusal
 *     can add lines but not edit, truncate or delete them.
 * With auditing off (AUDIT_DIR=off and no hosted store) they stay in store/.
 *
 * A log already in store/ is carried over once (see carryOver): its lines are
 * appended to the new file and the old file is renamed `<name>.moved`, so
 * /guard report keeps the history.
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { AUDIT_DIR, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { resolveAuditDir } from './audit-trail.js'
import { logger } from '../logger.js'

export type EvidenceLog = 'tool-guard.jsonl' | 'role-log.jsonl'

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The audit store these logs may use: on, and outside the install. */
export function evidenceDir(configured: string = AUDIT_DIR, workspace: string = PROJECT_ROOT, hostedDir?: string): string | null {
  const dir = hostedDir === undefined ? resolveAuditDir(configured) : resolveAuditDir(configured, hostedDir)
  if (!dir || inside(dir, workspace) || inside(workspace, dir)) return null
  return dir
}

const carried = new Set<string>()

/**
 * Append a log left in store/ to its new home. Once per log, ever: a marker
 * beside the new file records that it happened, so a file the assistant puts
 * back in store/ later is never imported (it could hold made-up entries).
 * Only a regular file (never a symlink) and only lines that are JSON objects
 * are taken. Never throws.
 */
function carryOver(oldPath: string, newPath: string): void {
  if (carried.has(newPath)) return
  carried.add(newPath)
  const marker = `${newPath}.carried`
  try {
    if (existsSync(marker)) return
    const st = existsSync(oldPath) ? lstatSync(oldPath) : null
    mkdirSync(dirname(newPath), { recursive: true, mode: 0o700 })
    if (st?.isFile()) {
      const lines = readFileSync(oldPath, 'utf-8').split('\n').filter((l) => {
        try { const v = JSON.parse(l); return Boolean(v) && typeof v === 'object' && !Array.isArray(v) } catch { return false }
      })
      if (lines.length) appendFileSync(newPath, lines.join('\n') + '\n', { mode: 0o600 })
      renameSync(oldPath, `${oldPath}.moved`)
      logger.info({ from: oldPath, to: newPath, lines: lines.length }, 'Moved a guard log out of store/ (card #237)')
    } else if (st) {
      logger.warn({ from: oldPath }, 'Not moving a guard log that is not a regular file')
    }
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch (err) {
    logger.warn({ err: String(err), from: oldPath }, 'Could not move a guard log out of store/')
  }
}

/**
 * The file for one evidence log. `storeDir` is where it lived before (and
 * still lives with auditing off).
 */
export function evidenceLogPath(name: EvidenceLog, storeDir: string = STORE_DIR, dir: string | null = evidenceDir()): string {
  const old = resolve(storeDir, name)
  if (!dir) return old
  const path = join(dir, name)
  carryOver(old, path)
  return path
}

/** Tests only. */
export function resetEvidenceLogs(): void {
  carried.clear()
}
