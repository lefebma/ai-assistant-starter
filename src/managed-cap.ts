/**
 * The cap on a managed box running the open-model engine (card #268).
 *
 * On the claude engine Anthropic's workspace limit is the hard stop and the box
 * only mirrors it. An OpenAI-compatible host has no such limit we can rely on,
 * so here the box is the stop: every model call adds its priced cost to the
 * month, a turn stops at the next step once the cap is reached, and no new
 * turn starts until the month turns over or the cap is raised. The pause uses
 * the same marker as the claude engine, so the owner's messages, the
 * scheduler skip and the operator's monitor all work unchanged.
 */
import { STORE_DIR } from './config.js'
import { readEnvFile } from './env.js'
import { clearAiLimit, isManagedAi, readAiLimit, writeAiLimit, type AiLimitKind } from './ai-limit.js'
import { capReached, nextUtcMonthStart, readManagedCap, readManagedPrices, recordManagedSpend, tokenCostUsd, type StepTokens } from './ai-usage.js'
import { logger } from './logger.js'

export type CapGate = { ok: true } | { paused: AiLimitKind } | { notSetUp: true }

/** The host the box talks to is named in .env. Without AI_BASE_URL the key would go to OpenAI itself. */
function hostConfigured(): boolean {
  const env = readEnvFile(['AI_BASE_URL', 'AI_MODEL'])
  const read = (k: 'AI_BASE_URL' | 'AI_MODEL') => env[k]?.trim() || process.env[k]?.trim()
  return Boolean(read('AI_BASE_URL') && read('AI_MODEL'))
}

/** Write the cap pause unless one is already set (keeps since and what the owner was told). */
export function markCapPause(storeDir: string = STORE_DIR, now: Date = new Date()): void {
  try {
    if (readAiLimit(storeDir)) return
    writeAiLimit({ kind: 'spend_limit', since: now.toISOString(), resumesAt: nextUtcMonthStart(now).toISOString(), source: 'cap' }, storeDir)
    logger.warn('AI allowance reached on the open-model engine; managed box paused')
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not record the cap pause')
  }
}

/**
 * Before any model call. Not managed: go. No prices or no cap recorded: the
 * box cannot count or stop, so it does not call the model (fails closed). At
 * the cap: paused. Under the cap with a pause still set (the month turned
 * over, or the cap was raised): lift it and go.
 */
export function capGate(storeDir: string = STORE_DIR, now: Date = new Date()): CapGate {
  if (!isManagedAi(storeDir)) return { ok: true }
  if (!readManagedPrices(storeDir) || readManagedCap(storeDir) === undefined || !hostConfigured()) {
    logger.error('Managed open-model box is missing prices, a cap, AI_BASE_URL or AI_MODEL; not calling the model')
    return { notSetUp: true }
  }
  if (capReached(storeDir, now)) {
    markCapPause(storeDir, now)
    // Stamp the check, so the recovery timer waits its full interval instead
    // of asking every minute (no model call happens either way).
    const marker = readAiLimit(storeDir)
    if (marker) writeAiLimit({ ...marker, lastProbeAt: now.toISOString() }, storeDir)
    return { paused: marker?.kind ?? 'spend_limit' }
  }
  if (readAiLimit(storeDir)) {
    clearAiLimit(storeDir)
    logger.info('Open-model spend is under the cap again; managed box resumed')
  }
  return { ok: true }
}

/** After each model call: add its cost, and pause straight away if that reached the cap. Never throws. */
export function recordStepSpend(tokens: StepTokens | undefined, storeDir: string = STORE_DIR, now: Date = new Date()): void {
  try {
    if (!tokens || !isManagedAi(storeDir)) return
    const prices = readManagedPrices(storeDir)
    if (!prices) return
    recordManagedSpend(tokenCostUsd(tokens, prices), { storeDir, now })
    if (capReached(storeDir, now)) markCapPause(storeDir, now)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Could not record open-model spend')
  }
}
