/**
 * The privacy name finder (card #275): notices people and companies in the
 * owner's own messages and offers each one for the privacy list.
 *
 * Nothing here is in a turn's path. The owner's text is queued as the turn
 * starts and read later, one message at a time, by the name model in this
 * process. A new name has therefore already gone out once; every mention
 * after the owner taps Add is protected. Cards go out on a timer like tips:
 * at most three a day, never in quiet hours, never while a reply is running.
 * It only runs while the privacy filter is on somewhere.
 */
import { logger } from '../../logger.js'
import { getQuietHours, quietUntil } from '../../proactive/settings.js'
import { privacyOnFor } from '../index.js'
import { filterFinds, mergeTags } from './detect.js'
import type { ModelTagger } from './model.js'
import { markOffered, nextSuggestion, offeredToday, recordFinds, suggestionText, SUGGESTION_BUTTONS } from './suggestions.js'

export const DAILY_CAP = 3
export const QUEUE_LIMIT = 50
const TICK_MS = 30 * 60_000
const FIRST_TICK_MS = 10 * 60_000

export interface FinderDeps {
  tagger: ModelTagger
  /** Sends to the owner's main chat. Returns the card's id when it has buttons. */
  send: (text: string, buttons: string[]) => Promise<string | null>
  buttons: boolean
  busy: () => boolean
  now: () => Date
  tz: string
  /** Lowercased names never to offer: the owner's and the assistant's own. */
  skip: () => Set<string>
}

const queue: string[] = []
let active: FinderDeps | null = null
let draining = false

/** Test seams. */
export const finderQueueLength = (): number => queue.length
export function clearFinderQueue(): void {
  queue.length = 0
}

/** Every text the owner types comes through here. Never waits and never throws. */
export function noteForFinder(primary: boolean, text: string): void {
  try {
    if (!active || !primary || active.tagger.disabled()) return
    const t = text.trim()
    if (t.length < 3 || t.startsWith('/')) return
    if (!privacyOnFor(undefined)) return
    queue.push(t)
    if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT)
    if (workerOn) kick()
  } catch {
    /* the finder never gets in a turn's way */
  }
}

let workerOn = true

function kick(): void {
  if (draining || !active) return
  const deps = active
  draining = true
  setImmediate(() => {
    void drainQueue(deps).finally(() => {
      draining = false
      if (queue.length && active) kick()
    })
  })
}

/** Read every queued message. Exported for tests. */
export async function drainQueue(deps: FinderDeps): Promise<void> {
  for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
    try {
      const tags = await deps.tagger.tag(text)
      if (!tags.length) continue
      const added = recordFinds(filterFinds(mergeTags(text, tags), deps.skip()))
      if (added) logger.info({ added }, 'Privacy name finder: new names to suggest')
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Privacy name finder: could not read a message')
    }
  }
}

export type OfferOutcome = 'held' | 'nothing' | 'sent' | 'failed'

/** Offer the next name, if now is a good time. */
export async function offerTick(deps: FinderDeps): Promise<OfferOutcome> {
  deps.tagger.unloadIfIdle()
  const nowMs = deps.now().getTime()
  if (!privacyOnFor(undefined)) return 'held'
  if (quietUntil(nowMs, deps.tz, getQuietHours()) !== null) return 'held'
  if (deps.busy()) return 'held'
  if (offeredToday(nowMs, deps.tz) >= DAILY_CAP) return 'held'
  const next = nextSuggestion()
  if (!next) return 'nothing'
  let card: string | null
  try {
    card = await deps.send(suggestionText(next.value, deps.buttons), SUGGESTION_BUTTONS)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Privacy name finder: could not send a suggestion')
    return 'failed'
  }
  markOffered(next.id, card, nowMs)
  return 'sent'
}

/** Start reading and offering. First offer pass after ten minutes, then every half hour. */
export function startNameFinder(deps: FinderDeps, opts: { worker?: boolean } = {}): () => void {
  active = deps
  workerOn = opts.worker !== false
  const run = (): void => {
    void offerTick(deps).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'Privacy name finder tick failed')
    })
  }
  const first = setTimeout(run, FIRST_TICK_MS)
  const timer = setInterval(run, TICK_MS)
  first.unref?.()
  timer.unref?.()
  logger.info('Privacy name finder started')
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    if (active === deps) active = null
    workerOn = true
  }
}
