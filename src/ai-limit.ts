import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'

export type AiLimitKind = 'spend_limit' | 'billing' | 'org_cap'

export interface AiLimitMarker {
  kind: AiLimitKind
  since: string
  lastRequestId?: string
  lastProbeAt?: string
  lastToldAt?: string
  toldFull?: boolean
}

export const AI_LIMIT_FILE = 'ai-limit.json'
export const MANAGED_AI_FILE = 'managed-ai.json'

const DEFAULT_RECOVERY_MS = 15 * 60_000
const REPEAT_AFTER_MS = 24 * 60 * 60_000

export const FIRST_REPLY =
  "I've reached this month's AI allowance, so I'm paused for now. Your provider has been told and will be in touch."
export const REPEAT_REPLY = "Still paused: this month's AI allowance is used up. Your provider has been told."

export function isManagedAi(storeDir: string = STORE_DIR): boolean {
  return existsSync(join(storeDir, MANAGED_AI_FILE))
}

export function readAiLimit(storeDir: string = STORE_DIR): AiLimitMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, AI_LIMIT_FILE), 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || typeof raw.since !== 'string') return null
    return raw as AiLimitMarker
  } catch {
    return null
  }
}

export function writeAiLimit(m: AiLimitMarker, storeDir: string = STORE_DIR): void {
  mkdirSync(storeDir, { recursive: true })
  const target = join(storeDir, AI_LIMIT_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  renameSync(tmp, target)
}

export function clearAiLimit(storeDir: string = STORE_DIR): void {
  rmSync(join(storeDir, AI_LIMIT_FILE), { force: true })
}

/**
 * Provisional: status and error type first, then message wording. Task A9
 * replaces these with text captured from the real CLI. Keep matching narrow.
 */
export const LIMIT_PATTERNS: Record<AiLimitKind, { status?: number; errorType?: RegExp; message: RegExp[] }> = {
  spend_limit: {
    status: 400,
    errorType: /invalid_request_error/,
    message: [/reached its (?:monthly )?spend limit/i, /workspace[^"]*spend limit/i, /reached your specified workspace API usage limits?/i],
  },
  billing: {
    status: 402,
    errorType: /billing_error/,
    message: [/billing_error/i, /credit balance is too low/i],
  },
  org_cap: {
    status: 429,
    errorType: /rate_limit_error/,
    message: [/spend cap/i, /organization[^"]*(?:usage|spend) limit/i],
  },
}

export function classifyAiError(text: string): { kind: AiLimitKind; requestId?: string } | null {
  const requestId = text.match(/req_[A-Za-z0-9]+/)?.[0]
  for (const kind of Object.keys(LIMIT_PATTERNS) as AiLimitKind[]) {
    const p = LIMIT_PATTERNS[kind]
    const statusOk = p.status !== undefined && new RegExp(`\\b${p.status}\\b`).test(text)
    const typeOk = p.errorType ? p.errorType.test(text) : false
    const msgOk = p.message.some((re) => re.test(text))
    // billing: the 402 status or the billing_error type alone is enough.
    if (kind === 'billing' ? statusOk || /billing_error/.test(text) || msgOk : (statusOk || typeOk) && msgOk) {
      return requestId ? { kind, requestId } : { kind }
    }
  }
  return null
}

export function recoveryDue(m: AiLimitMarker, now: Date, intervalMs: number = DEFAULT_RECOVERY_MS): boolean {
  const last = Date.parse(m.lastProbeAt ?? m.since)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= intervalMs
}

export function ownerPauseReply(m: AiLimitMarker, now: Date): { text: string; next: AiLimitMarker } | null {
  const told = m.lastToldAt ? Date.parse(m.lastToldAt) : NaN
  const stamp = { ...m, lastToldAt: now.toISOString(), toldFull: true }
  if (!m.toldFull || Number.isNaN(told)) return { text: FIRST_REPLY, next: stamp }
  if (now.getTime() - told >= REPEAT_AFTER_MS) return { text: REPEAT_REPLY, next: stamp }
  return null
}

/**
 * Thrown by a one-shot run (runOnce) on a managed box instead of calling the
 * model while paused, or when the call itself hits a limit. Batch callers
 * own failure handling, so they get a typed error, not error text.
 */
export class AiPausedError extends Error {
  readonly kind: AiLimitKind
  constructor(kind: AiLimitKind) {
    super(`AI paused: ${kind}`)
    this.name = 'AiPausedError'
    this.kind = kind
  }
}

/**
 * True while the allowance marker is set and the next recovery probe is not
 * yet due. Background callers (scheduler, email alerts, dreaming, replay,
 * self-test) skip their model work on this; once recovery is due the runtime
 * makes the single probe itself, so they proceed normally.
 */
export function aiPausedNow(now: Date = new Date(), storeDir: string = STORE_DIR): boolean {
  const m = readAiLimit(storeDir)
  return m !== null && !recoveryDue(m, now)
}
