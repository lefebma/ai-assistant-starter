/**
 * The timer that sends tips (card #273). In-process rather than a scheduled
 * task, like the update notice: a scheduled task runs a model turn, and a tip
 * is a list lookup. No tokens are spent, so tips keep working on a capped box.
 *
 * Tips go to the owner's main chat only, and never turn anything on.
 */
import { logger } from '../logger.js'
import { localHour } from '../update/notice.js'
import { getQuietHours, quietUntil } from '../proactive/settings.js'
import type { TipContext } from './catalog.js'
import { holdReason, isNewer, loadState, markUsed, nextTip, paceAllows, recordSent, saveState, updateTips, type TipState } from './state.js'
import { TIP_BUTTONS, renderTip, renderUpdateTips } from './text.js'

export const TICK_MS = 30 * 60_000
const FIRST_TICK_MS = 10 * 60_000

export interface TipDeps {
  context: () => Promise<TipContext>
  /** Sends to the owner's chat. Returns the card's id when it has buttons. */
  send: (text: string, buttons: string[]) => Promise<string | null>
  buttons: boolean
  currentVersion: () => string
  busy: () => boolean
  lastOwnerMs: () => number
  now: () => Date
  tz: string
}

function everShown(s: TipState): boolean {
  return Object.values(s.tips).some((r) => r.shown > 0)
}

export type TickOutcome = 'first-run' | 'held' | 'update' | 'paced' | 'nothing' | 'failed'

export async function tipTick(deps: TipDeps): Promise<TickOutcome> {
  const now = deps.now()
  const nowMs = now.getTime()
  const version = deps.currentVersion()
  const first = loadState()

  // A new box, or one meeting tips for the first time: nothing to catch up on.
  if (!first.startedAt) {
    first.startedAt = nowMs
    first.version = version
    saveState(first)
    return 'first-run'
  }
  if (first.pace === 'off') {
    if (first.version !== version) {
      first.version = version
      saveState(first)
    }
    return 'held'
  }

  // Reading the connections takes a moment, and /tips off can arrive during
  // it, so the state is read after and again after each send, never held
  // across a wait: a tick must not write an old pace back.
  const ctx = await deps.context()
  const s = loadState()
  if (markUsed(s, ctx)) saveState(s)

  const hold = holdReason(s, {
    nowMs,
    localHour: localHour(now, deps.tz),
    inQuietHours: quietUntil(nowMs, deps.tz, getQuietHours()) !== null,
    busy: deps.busy(),
    lastOwnerMs: deps.lastOwnerMs(),
  })
  if (hold) {
    logger.debug({ hold }, 'Tips: holding')
    return 'held'
  }

  const opts = { buttons: deps.buttons, firstEver: !everShown(s) }
  const send = async (text: string, ids: string[], told?: string): Promise<boolean> => {
    let card: string | null
    try {
      card = await deps.send(text, TIP_BUTTONS)
    } catch (err) {
      // Unsent means untold: the next tick tries again.
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Tips: could not send')
      return false
    }
    const after = loadState()
    recordSent(after, ids, card, nowMs, true)
    if (told) after.version = told
    saveState(after)
    return true
  }

  if (isNewer(version, s.version)) {
    const tips = updateTips(s, ctx, nowMs)
    if (tips.length > 0) return (await send(renderUpdateTips(version, tips, opts), tips.map((t) => t.id), version)) ? 'update' : 'failed'
    s.version = version
    saveState(s)
  }

  if (!paceAllows(s, nowMs)) return 'held'
  const tip = nextTip(s, ctx, nowMs)
  if (!tip) return 'nothing'
  return (await send(renderTip(tip, opts), [tip.id])) ? 'paced' : 'failed'
}

/** First pass after ten minutes, then every half hour. Never throws. */
export function startTips(deps: TipDeps): () => void {
  const run = (): void => {
    void tipTick(deps).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Tips tick failed')
    })
  }
  const first = setTimeout(run, FIRST_TICK_MS)
  const timer = setInterval(run, TICK_MS)
  first.unref?.()
  timer.unref?.()
  logger.info('Tips service started')
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
