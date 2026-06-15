/**
 * Sync always-on skills from the bundled templates/ into the live skills/ dir.
 *
 * Runs in two places:
 *   1. Inside applyUpdate() — installs any always-on skill the user is missing
 *      right after engine files land.
 *   2. On bot startup — catches clients who upgraded from a version that didn't
 *      install always-on skills automatically. Idempotent.
 *
 * Only installs skills that are MISSING. Never overwrites a user-customized skill.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')

// Skills that should ship with every install, no opt-in required.
// Keep this list short — these run on every startup.
const ALWAYS_ON_SKILLS = ['weather', 'decision-log'] as const

export interface SyncResult {
  installed: string[]
  skipped: string[]
  errors: string[]
}

/**
 * Read OWNER_NAME from CLAUDE.md by matching the setup-substituted pattern:
 *   "You are <NAME>'s personal AI assistant"
 * Falls back to "User" if CLAUDE.md is missing or doesn't match.
 */
function extractOwnerName(): string {
  try {
    const claude = readFileSync(resolve(PROJECT_ROOT, 'CLAUDE.md'), 'utf-8')
    const m = claude.match(/^You are (.+?)'s personal AI assistant/m)
    if (m && m[1] && !m[1].includes('{{')) return m[1].trim()
  } catch {
    // CLAUDE.md missing — fall through
  }
  return 'User'
}

/**
 * Substitute {{OWNER_NAME}} and {{PROJECT_PATH}} placeholders in a file.
 * Silent no-op if the file can't be read/written (logged at debug).
 */
function substitutePlaceholders(filePath: string, ownerName: string): void {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const updated = content
      .replace(/\{\{OWNER_NAME\}\}/g, ownerName)
      .replace(/\{\{PROJECT_PATH\}\}/g, PROJECT_ROOT)
    if (updated !== content) {
      writeFileSync(filePath, updated)
    }
  } catch (err) {
    logger.debug({ err, filePath }, 'placeholder substitution failed')
  }
}

/**
 * Walk a directory and substitute placeholders in every text file.
 */
function substituteInTree(dir: string, ownerName: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      substituteInTree(full, ownerName)
    } else if (entry.isFile()) {
      // Only touch text-ish files — skip binaries
      if (/\.(md|json|sh|js|ts|py|txt)$/i.test(entry.name)) {
        substitutePlaceholders(full, ownerName)
      }
    }
  }
}

/**
 * Install missing always-on skills from templates/skills/.
 * For decision-log, also scaffold decisions/log.md if missing.
 * Idempotent — only writes when target doesn't exist.
 */
export function syncAlwaysOnSkills(): SyncResult {
  const result: SyncResult = { installed: [], skipped: [], errors: [] }
  const templatesRoot = resolve(PROJECT_ROOT, 'templates', 'skills')
  const skillsRoot = resolve(PROJECT_ROOT, 'skills')

  if (!existsSync(templatesRoot)) {
    logger.warn({ templatesRoot }, 'templates/skills/ missing; cannot sync always-on skills')
    return result
  }

  const ownerName = extractOwnerName()

  for (const id of ALWAYS_ON_SKILLS) {
    const src = resolve(templatesRoot, id)
    const dst = resolve(skillsRoot, id)

    if (!existsSync(src)) {
      result.errors.push(`template missing: ${id}`)
      continue
    }
    if (existsSync(dst)) {
      result.skipped.push(id)
      continue
    }

    try {
      mkdirSync(skillsRoot, { recursive: true })
      cpSync(src, dst, { recursive: true })
      substituteInTree(dst, ownerName)
      result.installed.push(id)
      logger.info({ skill: id }, 'installed missing always-on skill')
    } catch (err) {
      result.errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // decision-log needs decisions/log.md to write into
  const logTemplate = resolve(PROJECT_ROOT, 'templates', 'decisions', 'log.md')
  const logTarget = resolve(PROJECT_ROOT, 'decisions', 'log.md')
  if (existsSync(logTemplate) && !existsSync(logTarget)) {
    try {
      mkdirSync(dirname(logTarget), { recursive: true })
      const content = readFileSync(logTemplate, 'utf-8').replace(/\{\{OWNER_NAME\}\}/g, ownerName)
      writeFileSync(logTarget, content)
      logger.info('scaffolded decisions/log.md')
    } catch (err) {
      result.errors.push(`decisions/log.md: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
