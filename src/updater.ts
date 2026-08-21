/**
 * Update system for AI Assistant instances.
 *
 * Two install kinds update differently; src/update/plan.ts owns the rules and
 * the reasoning. Source installs fetch the repo and rebuild. Bundle installs
 * swap in a published release payload, because they have no TypeScript
 * toolchain and frequently no system npm at all.
 *
 * Everything here is I/O over those decisions. Downloads use global fetch and
 * extraction uses tar, both of which exist on macOS, Linux, and Windows 10+.
 * The old curl+unzip pair did not: Windows ships neither unzip nor a way to
 * get one, so /update could not even reach its first step there.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logger } from './logger.js'
import { PROJECT_ROOT } from './env.js'
import { syncAlwaysOnSkills } from './skills/sync.js'
import { ensurePlaywrightMcp } from './setup/mcp-config.js'
import {
  detectInstallKind,
  bundleAssetName,
  pickReleaseAsset,
  planUpdate,
  BUNDLE_PAYLOAD_PATHS,
  PRESERVED_PATHS,
  type InstallEnvironment,
} from './update/plan.js'
import { moveAside, moveInto, restoreBackup } from './update/swap.js'


/**
 * Register the Playwright browser tools after a payload swap.
 *
 * Same role as syncAlwaysOnSkills above: reconcile owner-facing config that the
 * payload itself must not carry. .mcp.json is in neither PRESERVED_PATHS nor
 * BUNDLE_PAYLOAD_PATHS, so an update leaves it alone, which would strand every
 * install predating browser automation until its owner re-ran setup by hand.
 * Merging (never replacing) keeps a hand-edited entry intact, and a failure
 * here costs browser tools, not the update.
 */
function syncPlaywrightMcp(): void {
  try {
    const { outcome } = ensurePlaywrightMcp(PROJECT_ROOT, process.execPath)
    if (outcome === 'created' || outcome === 'added') {
      logger.info({ outcome }, 'Registered Playwright browser tools in .mcp.json')
    } else if (outcome === 'unparsable') {
      logger.warn('.mcp.json is not valid JSON; left untouched, browser tools not registered')
    }
  } catch (err) {
    logger.warn({ err }, 'Could not register browser tools; continuing update')
  }
}

const GITHUB_REPO = 'lefebma/ai-assistant-starter'
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`
const GITHUB_TARBALL_URL = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz`

/** Auth headers for private-repo access. Without a token every fetch 404s. */
function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.GITHUB_TOKEN
  if (!token) return extra
  return { Authorization: `Bearer ${token}`, ...extra }
}

// Files that get replaced during a source update (engine + config + bundled templates).
// `templates/` ships new always-on skills and updated optional-skill templates;
// existing user skills under `skills/` are preserved (PRESERVED_PATHS above).
const ENGINE_PATHS = [
  'src',
  'scripts',
  'package.json',
  'tsconfig.json',
  'templates',
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
    const resp = await fetch(`${GITHUB_RAW_BASE}/VERSION`, {
      headers: githubHeaders(),
    })
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

// ── Install inspection ──

function currentEnvironment(): InstallEnvironment {
  return {
    hasCompiledApp: existsSync(resolve(PROJECT_ROOT, 'dist', 'src', 'index.js')),
    hasDependencies: existsSync(resolve(PROJECT_ROOT, 'node_modules')),
    hasBuildToolchain: existsSync(resolve(PROJECT_ROOT, 'node_modules', 'typescript')),
  }
}

/** Release asset for this platform, or null when none has been published. */
async function resolveBundleAsset(version: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`, {
      headers: githubHeaders({ Accept: 'application/vnd.github+json' }),
    })
    if (!resp.ok) return null
    const release = (await resp.json()) as { assets?: { name: string; browser_download_url: string }[] }
    return pickReleaseAsset(release.assets ?? [], bundleAssetName(version, process.platform, process.arch))
  } catch (err) {
    logger.warn({ err }, 'Could not look up release assets')
    return null
  }
}

// ── Transport ──

async function download(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: githubHeaders({ Accept: 'application/octet-stream' }),
  })
  if (!resp.ok) throw new Error(`Download failed (${resp.status}) for ${url}`)
  writeFileSync(dest, Buffer.from(await resp.arrayBuffer()))
}

function extractTarGz(archive: string, into: string): void {
  execFileSync('tar', ['-xzf', archive, '-C', into], { timeout: 120_000 })
}

/**
 * Which stage of the swap an update died in. Rollback needs to know: after a
 * failed apply the target paths hold disposable new payload; after a failed
 * stash they hold the remains of the old install (src/update/swap.ts).
 */
type SwapPhase = 'fetch' | 'stash' | 'apply'

// ── Apply update ──

export async function applyUpdate(): Promise<UpdateResult> {
  const currentVersion = getCurrentVersion()
  const status = await checkForUpdate(false)
  const kind = detectInstallKind(currentEnvironment())

  const assetUrl =
    kind === 'bundle' && status.updateAvailable && status.latestVersion
      ? await resolveBundleAsset(status.latestVersion)
      : null

  const plan = planUpdate({
    kind,
    currentVersion,
    latestVersion: status.latestVersion,
    updateAvailable: status.updateAvailable,
    assetUrl,
    error: status.error,
  })

  if (plan.action === 'none') {
    return {
      success: false,
      fromVersion: currentVersion,
      toVersion: status.latestVersion ?? currentVersion,
      message: plan.message,
    }
  }

  const targetVersion = status.latestVersion as string

  return plan.action === 'replace-bundle'
    ? applyBundleUpdate(currentVersion, targetVersion, assetUrl as string)
    : applySourceUpdate(currentVersion, targetVersion)
}

/**
 * Bundle path: fetch the published payload and swap it in. No npm, no tsc, no
 * compile step — the payload is already built against the pinned runtime.
 */
async function applyBundleUpdate(
  currentVersion: string,
  targetVersion: string,
  assetUrl: string
): Promise<UpdateResult> {
  const backupDir = resolve(PROJECT_ROOT, 'store', `backup-v${currentVersion}-${Date.now()}`)
  const tempDir = resolve(PROJECT_ROOT, 'store', 'update-temp')
  let phase: SwapPhase = 'fetch'

  try {
    logger.info({ targetVersion, assetUrl }, 'Downloading release payload')
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })

    const archivePath = resolve(tempDir, 'payload.tar.gz')
    await download(assetUrl, archivePath)
    extractTarGz(archivePath, tempDir)

    // build-installer archives the staging root, so the app payload lands in app/.
    const payloadDir = resolve(tempDir, 'app')
    if (!existsSync(payloadDir)) {
      throw new Error('Release payload has no app/ directory')
    }

    // Rename, never delete: this process still has native addons mapped from
    // node_modules, and Windows refuses to unlink those (issue #27).
    logger.info({ backupDir }, 'Moving current payload aside')
    phase = 'stash'
    moveAside(PROJECT_ROOT, backupDir, BUNDLE_PAYLOAD_PATHS)

    logger.info('Moving release payload into place')
    phase = 'apply'
    moveInto(payloadDir, PROJECT_ROOT, BUNDLE_PAYLOAD_PATHS)

    try {
      const syncResult = syncAlwaysOnSkills()
      if (syncResult.installed.length > 0) {
        logger.info({ installed: syncResult.installed }, 'Installed new always-on skills')
      }
    } catch (syncErr) {
      logger.warn({ syncErr }, 'Always-on skill sync failed; continuing update')
    }

    syncPlaywrightMcp()

    rmSync(tempDir, { recursive: true, force: true })
    saveCachedStatus({
      currentVersion: targetVersion,
      latestVersion: targetVersion,
      updateAvailable: false,
      checkedAt: Date.now(),
    })

    logger.info({ from: currentVersion, to: targetVersion }, 'Bundle update applied')
    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      message: `Updated from ${currentVersion} to ${targetVersion}. Restart to activate.`,
    }
  } catch (err) {
    logger.error({ err, phase }, 'Bundle update failed, rolling back')
    try {
      if (phase !== 'fetch' && existsSync(backupDir)) {
        restoreBackup(PROJECT_ROOT, backupDir, BUNDLE_PAYLOAD_PATHS, { clearTargets: phase === 'apply' })
      }
    } catch (rollbackErr) {
      logger.error({ rollbackErr }, 'Rollback also failed')
    }
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}

    return {
      success: false,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      message: `Update failed: ${err instanceof Error ? err.message : String(err)}. Rolled back to ${currentVersion}.`,
    }
  }
}

/** Source path: fetch the repo, replace engine files, reinstall and rebuild. */
async function applySourceUpdate(currentVersion: string, targetVersion: string): Promise<UpdateResult> {
  const backupDir = resolve(PROJECT_ROOT, 'store', `backup-v${currentVersion}-${Date.now()}`)
  const tempDir = resolve(PROJECT_ROOT, 'store', 'update-temp')
  let phase: SwapPhase = 'fetch'

  try {
    // 2. Download and extract the source tarball
    logger.info({ targetVersion }, 'Downloading update')
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })

    const archivePath = resolve(tempDir, 'update.tar.gz')
    await download(GITHUB_TARBALL_URL, archivePath)
    extractTarGz(archivePath, tempDir)

    const extractedDir = resolve(tempDir, 'ai-assistant-starter-main')

    if (!existsSync(extractedDir)) {
      throw new Error('Extracted directory not found')
    }

    // 4. Move current engine files aside (same rename-based swap as the
    // bundle path; engine files are not memory-mapped, but one mechanism
    // beats two)
    logger.info({ backupDir }, 'Moving current engine files aside')
    phase = 'stash'
    moveAside(PROJECT_ROOT, backupDir, ENGINE_PATHS)

    // 5. Move engine files in from the update (skip preserved paths)
    logger.info('Applying update files')
    phase = 'apply'
    moveInto(extractedDir, PROJECT_ROOT, ENGINE_PATHS)

    // 6. Copy any new top-level files that aren't preserved
    // (e.g., new config files, README updates)
    const topLevelExtras = ['README.md', '.gitignore']
    for (const f of topLevelExtras) {
      const src = resolve(extractedDir, f)
      if (existsSync(src)) {
        cpSync(src, resolve(PROJECT_ROOT, f))
      }
    }

    // 6b. Install any new always-on skills bundled in templates/
    // (existing user skills are never overwritten)
    try {
      const syncResult = syncAlwaysOnSkills()
      if (syncResult.installed.length > 0) {
        logger.info({ installed: syncResult.installed }, 'Installed new always-on skills')
      }
      if (syncResult.errors.length > 0) {
        logger.warn({ errors: syncResult.errors }, 'Some always-on skills failed to install')
      }
    } catch (syncErr) {
      logger.warn({ syncErr }, 'Always-on skill sync failed; continuing update')
    }

    // 6c. Register the browser tools for installs that predate them.
    syncPlaywrightMcp()

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
    logger.error({ err, phase }, 'Update failed, attempting rollback')
    try {
      if (phase !== 'fetch' && existsSync(backupDir)) {
        restoreBackup(PROJECT_ROOT, backupDir, ENGINE_PATHS, { clearTargets: phase === 'apply' })
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
    const resp = await fetch(`${GITHUB_RAW_BASE}/CHANGELOG.md`, {
      headers: githubHeaders(),
    })
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
