/**
 * The timer around the update notice. Everything it decides lives in
 * notice.ts; this only supplies the clock, the network and the chat.
 *
 * In-process rather than a scheduled task, for the same reason the workspace
 * sync is: a scheduled task runs a model turn, and "is there a new version"
 * is a string comparison. No tokens are spent to find out that nothing has
 * changed.
 */
import { logger } from '../logger.js'
import { installTimezone } from '../env.js'
import {
  decideNotice,
  loadNoticeState,
  localHour,
  renderNotice,
  saveNoticeState,
  type NoticeState,
} from './notice.js'

export interface UpdateNoticeDeps {
  /** Current/latest/updateAvailable, live rather than cached. */
  check: () => Promise<{ currentVersion: string; latestVersion: string | null; updateAvailable: boolean }>
  /** The release's changelog section, for the one-line summary. */
  changelog: (version: string) => Promise<string | null>
  restartPending: () => boolean
  notify: (text: string) => Promise<void>
  now?: () => Date
  timeZone?: () => string
  loadState?: () => NoticeState
  saveState?: (state: NoticeState) => void
}

/**
 * Every six hours, not daily: the check is one small HTTP request, and a
 * six-hour tick means a release published in the evening is announced the
 * next morning rather than a day later. Quiet hours do the rest.
 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Let the box finish booting before reaching for the network. */
export const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000

let timer: ReturnType<typeof setInterval> | undefined
let firstRun: ReturnType<typeof setTimeout> | undefined

/** One pass. Exported for tests and for anything that wants to force a check. */
export async function runUpdateNoticeOnce(deps: UpdateNoticeDeps): Promise<boolean> {
  const now = deps.now?.() ?? new Date()
  const state = (deps.loadState ?? loadNoticeState)()
  let status: Awaited<ReturnType<UpdateNoticeDeps['check']>>
  try {
    status = await deps.check()
  } catch (err) {
    // GitHub being unreachable is not worth a word to the owner.
    logger.debug({ err }, 'Update notice: check failed')
    return false
  }

  const decision = decideNotice({
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    updateAvailable: status.updateAvailable,
    localHour: localHour(now, (deps.timeZone ?? installTimezone)()),
    restartPending: deps.restartPending(),
    state,
  })
  if (!decision.announce) {
    logger.debug({ reason: decision.reason }, 'Update notice: staying quiet')
    return false
  }

  const changelog = await deps.changelog(decision.version).catch(() => null)
  try {
    await deps.notify(renderNotice(status.currentVersion, decision.version, changelog))
  } catch (err) {
    // Unsent means unannounced: leave the state alone so the next tick retries
    // rather than swallowing the only notice this version gets.
    logger.warn({ err }, 'Update notice: could not send')
    return false
  }
  ;(deps.saveState ?? saveNoticeState)({ announced: decision.version, at: now.toISOString() })
  logger.info({ version: decision.version }, 'Update notice sent')
  return true
}

export function initUpdateNotice(deps: UpdateNoticeDeps): void {
  const tick = () => {
    void runUpdateNoticeOnce(deps)
  }
  firstRun = setTimeout(tick, FIRST_CHECK_DELAY_MS)
  timer = setInterval(tick, CHECK_INTERVAL_MS)
  logger.info('Update notice service started')
}

export function stopUpdateNotice(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = undefined
  timer = undefined
}
