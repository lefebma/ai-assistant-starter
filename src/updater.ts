/**
 * Update system for AI Assistant instances.
 *
 * Checks GitHub for new versions, downloads and applies updates
 * while preserving user files (.env, CLAUDE.md, skills/, projects/, store/).
 *
 * Since clients install via curl+unzip (no git), updates work the same way:
 * download the zip, extract engine files, rebuild.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, renameSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { logger } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')

const GITHUB_REPO = 'lefebma/ai-assistant-starter'
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`
const GITHUB_ZIP_URL = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`

// Files/dirs that belong to the user and must NEVER be overwritten
const PRESERVED_PATHS = [
  '.env',
  'CLAUDE.md',
  'skills',
  'projects',
  'store',
  'seed-jobs.json',
]

// Files that get replaced during update (engine + config)
const ENGINE_PATHS = [
  'src',
  'scripts',
  'package.json',
  'tsconfig.json',
  'VERSION',
]

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: number // epoch ms
  error?: string
}

export interface UpdateResult {
  success: boolean
  fromVersion: string
  toVersion: string
  message: string
}

// ── Version helpers ──

export function getCurrentVersion(): string {
  try {
    return readFileSync(resolve(PROJECT_ROOT, 'VERSION'), 'utf-8').trim()
  } catch {
    return '0.0.0'
  }
}

function parseVersion(v: string): [number, number, number] {
  const parts = v.split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function isNewer(remote: string, local: string): boolean {
  const [rMaj, rMin, rPatch] = parseVersion(remote)
  const [lMaj, lMin, lPatch] = parseVersion(local)
  if (rMaj !== lMaj) return rMaj > lMaj
  if (rMin !== lMin) return rMin > lMin
  return rPatch > lPatch
}

// ── Cache ──
// Store last check result so morning briefings don't hit GitHub every time
const STATUS_FILE = resolve(PROJECT_ROOT, 'store', 'update-status.json')

function loadCachedStatus(): UpdateStatus | null {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function saveCachedStatus(status: UpdateStatus): void {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true })
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2))
  } catch (err) {
    logger.error({ err }, 'Failed to save update status cache')
  }
}

// ── Check for updates ──

export async function checkForUpdate(useCache = false): Promise<UpdateStatus> {
  const currentVersion = getCurrentVersion()

  // Return cached result if fresh (< 4 hours) and caller allows it
  if (useCache) {
    const cached = loadCachedStatus()
    if (cached && Date.now() - cached.checkedAt < 4 * 60 * 60 * 1000) {
      return { ...cached, currentVersion }
    }
  }

  try {
    const resp = await fetch(`${GITHUB_RAW_BASE}/VERSION`)
    if (!resp.ok) {
      throw new Error(`GitHub returned ${resp.status}`)
    }
    const latestVersion = (await resp.text()).trim()

    const status: UpdateStatus = {
      currentVersion,
      latestVersion,
      updateAvailable: isNewer(latestVersion, currentVersion),
      checkedAt: Date.now(),
    }
    saveCachedStatus(status)
    return status
  } catch (err) {
    const status: UpdateStatus = {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    }
    saveCachedStatus(status)
    return status
  }
}

// ── Apply update ──

export async function applyUpdate(): Promise<UpdateResult> {
  const currentVersion = getCurrentVersion()

  // 1. Check what's available
  const status = await checkForUpdate(false)
  if (!status.updateAvailable || !status.latestVersion) {
    return {
      success: false,
      fromVersion: currentVersion,
      toVersion: status.latestVersion ?? currentVersion,
      message: status.error
        ? `Update check failed: ${status.error}`
        : `Already on latest version (${currentVersion}).`,
    }
  }

  const targetVersion = status.latestVersion
  const backupDir = resolve(PROJECT_ROOT, 'store', `backup-v${currentVersion}-${Date.now()}`)
  const tempDir = resolve(PROJECT_ROOT, 'store', 'update-temp')

  try {
    // 2. Download the zip
    logger.info({ targetVersion }, 'Downloading update')
    const zipPath = resolve(tempDir, 'update.zip')
    mkdirSync(tempDir, { recursive: true })

    execFileSync('curl', ['-fsSL', GITHUB_ZIP_URL, '-o', zipPath], {
      timeout: 60_000,
    })

    // 3. Extract
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', tempDir], {
      timeout: 30_000,
    })
    const extractedDir = resolve(tempDir, 'ai-assistant-starter-main')

    if (!existsSync(extractedDir)) {
      throw new Error('Extracted directory not found')
    }

    // 4. Backup current engine files
    logger.info({ backupDir }, 'Backing up current engine files')
    mkdirSync(backupDir, { recursive: true })
    for (const p of ENGINE_PATHS) {
      const src = resolve(PROJECT_ROOT, p)
      const dst = resolve(backupDir, p)
      if (existsSync(src)) {
        const stat = statSync(src)
        if (stat.isDirectory()) {
          cpSync(src, dst, { recursive: true })
        } else {
          mkdirSync(dirname(dst), { recursive: true })
          cpSync(src, dst)
        }
      }
    }

    // 5. Copy engine files from update (skip preserved paths)
    logger.info('Applying update files')
    for (const p of ENGINE_PATHS) {
      const src = resolve(extractedDir, p)
      const dst = resolve(PROJECT_ROOT, p)
      if (!existsSync(src)) continue

      const stat = statSync(src)
      if (stat.isDirectory()) {
        // For directories like src/, replace entirely
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
        cpSync(src, dst, { recursive: true })
      } else {
        cpSync(src, dst)
      }
    }

    // 6. Copy any new top-level files that aren't preserved
    // (e.g., new config files, README updates)
    const topLevelExtras = ['README.md', '.gitignore']
    for (const f of topLevelExtras) {
      const src = resolve(extractedDir, f)
      if (existsSync(src)) {
        cpSync(src, resolve(PROJECT_ROOT, f))
      }
    }

    // 7. Install dependencies (package.json may have changed)
    logger.info('Installing dependencies')
    execFileSync('npm', ['install', '--production'], {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      stdio: 'pipe',
    })

    // 8. Rebuild TypeScript
    logger.info('Rebuilding TypeScript')
    execFileSync('npm', ['run', 'build'], {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      stdio: 'pipe',
    })

    // 9. Cleanup temp
    rmSync(tempDir, { recursive: true, force: true })

    // 10. Clear cached status
    const newStatus: UpdateStatus = {
      currentVersion: targetVersion,
      latestVersion: targetVersion,
      updateAvailable: false,
      checkedAt: Date.now(),
    }
    saveCachedStatus(newStatus)

    logger.info({ from: currentVersion, to: targetVersion }, 'Update applied successfully')

    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      message: `Updated from ${currentVersion} to ${targetVersion}. Restart the service to activate.`,
    }
  } catch (err) {
    // Attempt rollback
    logger.error({ err }, 'Update failed, attempting rollback')
    try {
      if (existsSync(backupDir)) {
        for (const p of ENGINE_PATHS) {
          const src = resolve(backupDir, p)
          const dst = resolve(PROJECT_ROOT, p)
          if (existsSync(src)) {
            const stat = statSync(src)
            if (stat.isDirectory()) {
              if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
              cpSync(src, dst, { recursive: true })
            } else {
              cpSync(src, dst)
            }
          }
        }
        // Rebuild after rollback
        execFileSync('npm', ['install', '--production'], { cwd: PROJECT_ROOT, timeout: 120_000, stdio: 'pipe' })
        execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, timeout: 60_000, stdio: 'pipe' })
      }
    } catch (rollbackErr) {
      logger.error({ rollbackErr }, 'Rollback also failed')
    }

    // Cleanup temp
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}

    return {
      success: false,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      message: `Update failed: ${err instanceof Error ? err.message : String(err)}. Rolled back to ${currentVersion}.`,
    }
  }
}

// ── Changelog ──

export async function getChangelog(): Promise<string | null> {
  try {
    const resp = await fetch(`${GITHUB_RAW_BASE}/CHANGELOG.md`)
    if (!resp.ok) return null
    const text = await resp.text()
    // Return just the latest entry (up to the second ## heading)
    const sections = text.split(/^## /m)
    if (sections.length >= 2) {
      return `## ${sections[1].trim()}`
    }
    return text.slice(0, 1000)
  } catch {
    return null
  }
}

// ── Morning briefing helper ──

export async function getUpdateBriefing(): Promise<string | null> {
  const status = await checkForUpdate(true) // use cache
  if (status.updateAvailable && status.latestVersion) {
    return `Update available: v${status.currentVersion} -> v${status.latestVersion}. Run /update to install.`
  }
  return null
}
