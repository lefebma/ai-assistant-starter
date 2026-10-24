/**
 * Recovery timer for a paused managed box (card #158).
 *
 * Background callers (scheduler, email alerts, replay, dreaming, self-test)
 * never act as the recovery probe: they skip while a marker exists. This
 * timer makes the probe instead. Every 60 s, if the marker is set and
 * recovery is due, it makes ONE tiny call through the managed runtime. The
 * runtime stamps lastProbeAt before the call and clears the marker on a real
 * answer. Failures are logged quietly; nothing is retried here.
 */
import { AiPausedError, isManagedAi, readAiLimit, recoveryDue } from './ai-limit.js'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

export const RECOVERY_PROBE_PROMPT = 'Reply with exactly one word: ready'
export const RECOVERY_TICK_MS = 60_000

export interface RecoveryDeps {
  storeDir?: string
  now?: () => Date
  /** The managed runtime's one-shot call. Defaults to getAgentRuntime('cron').runOnce. */
  runOnce?: (prompt: string, options: { model?: string }) => Promise<string>
}

export type RecoveryOutcome = 'none' | 'cleared' | 'still-paused' | 'error'

async function defaultRunOnce(prompt: string, options: { model?: string }): Promise<string> {
  const { getAgentRuntime } = await import('./runtime/index.js')
  return getAgentRuntime('cron').runOnce(prompt, options)
}

export async function recoveryProbeTick(deps: RecoveryDeps = {}): Promise<RecoveryOutcome> {
  const storeDir = deps.storeDir ?? STORE_DIR
  if (!isManagedAi(storeDir)) return 'none'
  const marker = readAiLimit(storeDir)
  if (!marker || !recoveryDue(marker, (deps.now ?? (() => new Date()))())) return 'none'
  try {
    await (deps.runOnce ?? defaultRunOnce)(RECOVERY_PROBE_PROMPT, { model: 'haiku' })
    if (readAiLimit(storeDir) === null) {
      logger.info('AI allowance recovery probe: resumed')
      return 'cleared'
    }
    logger.info('AI allowance recovery probe: still paused')
    return 'still-paused'
  } catch (err) {
    if (err instanceof AiPausedError) {
      logger.info({ kind: err.kind }, 'AI allowance recovery probe: still paused')
      return 'still-paused'
    }
    // The managed runtime scrubs the key from any error it rethrows.
    logger.info({ err: err instanceof Error ? err.message : String(err) }, 'AI allowance recovery probe failed')
    return 'error'
  }
}

/** Starts the timer on a managed box only. Returns a stop function. */
export function startAiRecovery(deps: RecoveryDeps = {}): () => void {
  if (!isManagedAi(deps.storeDir ?? STORE_DIR)) return () => {}
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    recoveryProbeTick(deps)
      .catch(() => 'error')
      .finally(() => {
        running = false
      })
  }, RECOVERY_TICK_MS)
  timer.unref?.()
  logger.info('AI allowance recovery timer started')
  return () => clearInterval(timer)
}
