/**
 * Auto-collected diagnostics for a support request.
 *
 * Collects only what a support inbox needs to triage: app version, OS + Node,
 * which skills are enabled (ids only — no skill context, which can carry
 * account names), and the recent error-level lines from the service log,
 * passed through the redaction pass before they go anywhere.
 *
 * Deliberately never read: .env, the vault, the SQLite store, message
 * content, or skill SKILL.md files.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform, release, arch } from 'node:os'
import { PROJECT_ROOT } from '../env.js'
import { getCurrentVersion } from '../updater.js'
import { getSkills } from '../skills/index.js'
import { redactSensitive } from './redact.js'

export interface SupportDiagnostics {
  appVersion: string
  os: string
  node: string
  enabledSkillIds: string[]
  /** Last error-level log lines, already redacted. Empty when no log exists. */
  errorLogTail: string[]
}

/** Injected boundary so tests never touch the real machine. */
export interface DiagnosticsIO {
  appVersion(): string
  osInfo(): string
  nodeVersion(): string
  enabledSkillIds(): string[]
  /** Raw tail of the service log, or null when no log file exists. */
  readLogTailRaw(): string | null
}

export const ERROR_LOG_TAIL_LINES = 30

/** Only read the end of the log; a long-lived service log can be huge. */
const LOG_READ_BYTES = 256 * 1024

const LOG_FILE = resolve(PROJECT_ROOT, 'logs', 'service.log')

function readFileTail(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length === 0) return ''
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const read = readSync(fd, buf, 0, length, start)
      return buf.toString('utf-8', 0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Is this line error-level? The service logs pino JSON in production
 * (level 50 = error, 60 = fatal) and pino-pretty text in dev.
 */
export function isErrorLogLine(line: string): boolean {
  if (/"level"\s*:\s*(50|60)\b/.test(line)) return true
  return /\b(ERROR|FATAL)\b/.test(line)
}

/** Last `max` error-level lines from a raw log excerpt. Pure, for tests. */
export function extractErrorLines(raw: string, max: number = ERROR_LOG_TAIL_LINES): string[] {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && isErrorLogLine(l))
  return lines.slice(-max)
}

export function defaultDiagnosticsIO(): DiagnosticsIO {
  return {
    appVersion: () => getCurrentVersion(),
    osInfo: () => `${platform()} ${release()} (${arch()})`,
    nodeVersion: () => process.version,
    enabledSkillIds: () =>
      getSkills()
        .filter((s) => s.manifest.enabled)
        .map((s) => s.manifest.id)
        .sort(),
    readLogTailRaw: () => readFileTail(LOG_FILE, LOG_READ_BYTES),
  }
}

/**
 * Collect everything the support draft needs. The redaction of the log tail
 * happens here, not in the caller, so no code path can assemble a draft from
 * unredacted log lines.
 */
export function collectDiagnostics(io: DiagnosticsIO = defaultDiagnosticsIO()): SupportDiagnostics {
  const raw = io.readLogTailRaw()
  const errorLogTail =
    raw === null ? [] : extractErrorLines(raw).map((line) => redactSensitive(line))

  return {
    appVersion: io.appVersion(),
    os: io.osInfo(),
    node: io.nodeVersion(),
    enabledSkillIds: io.enabledSkillIds(),
    errorLogTail,
  }
}
