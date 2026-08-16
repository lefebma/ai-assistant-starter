import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Nearest ancestor containing package.json — correct whether this module
 * runs compiled (dist/src/), from source (src/ under tsx/vitest), or inside
 * an installed bundle. The old fixed '../..' was wrong for source runs. */
function findProjectRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return resolve(start, '..', '..')
}

/** Exported so leaf modules (e.g. the vault) can resolve paths without importing
 * config.ts, which would form an import cycle once config resolves its secrets
 * through the vault. env.ts imports nothing from config/vault, so it's cycle-safe. */
export const PROJECT_ROOT = findProjectRoot(__dirname)

/**
 * Resolve an IANA timezone string, without ever inventing one.
 * Exported for tests; callers want installTimezone().
 */
export function resolveTimezone(
  fromProcess: string | undefined,
  fromEnvFile: string | undefined,
  hostZone: string | undefined
): string {
  const candidate = [fromProcess, fromEnvFile, hostZone].map((v) => v?.trim()).find(Boolean)
  return candidate || 'UTC'
}

let cachedTimezone: string | null = null

/**
 * The timezone this install runs in.
 *
 * 'America/Toronto' used to be hardcoded in the scheduler, the task table and
 * the ai-sdk system prompt. Setup has always asked for a timezone and written
 * TIMEZONE to .env; nothing read it back. So an owner in London got a briefing
 * at whatever 8am Toronto happened to be, and the model was told Toronto's
 * clock as fact on every single turn.
 */
export function installTimezone(): string {
  if (cachedTimezone) return cachedTimezone
  let hostZone: string | undefined
  try {
    hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    hostZone = undefined
  }
  cachedTimezone = resolveTimezone(process.env.TIMEZONE, readEnvFile(['TIMEZONE']).TIMEZONE, hostZone)
  return cachedTimezone
}

export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  let raw: string
  try {
    raw = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (keys && !keys.includes(key)) continue
    result[key] = value
  }

  return result
}
