/**
 * A restart request, passed from the command that wants one to the shutdown
 * handler that performs it.
 *
 * The graceful shutdown lives inside main() in index.ts, wired to SIGTERM, and
 * it is the only code that knows how to stop the adapter, the scheduler, the
 * HTTP server and Chrome in the right order and release the PID lock. A command
 * that wants a restart should use that path rather than a second one: it sets
 * the flag, raises SIGTERM on itself, and the existing handler runs and exits
 * with the code the supervisor needs.
 */
import { getAppState, setAppState } from '../db.js'
import { RESTART_EXIT_CODE } from '../service/supervisor.js'

let requested = false

export function requestRestart(): void {
  requested = true
}

export function restartRequested(): boolean {
  return requested
}

/** The code to exit with: a restart request, or a plain stop. */
export function shutdownExitCode(): number {
  return requested ? RESTART_EXIT_CODE : 0
}

/**
 * Telling the client the assistant is back.
 *
 * A restart is a hole, and on a webhook platform the hole eats messages. Teams
 * pushes each message once: while the process is down Caddy has no upstream,
 * answers 502, and that message is gone. Telegram is forgiving here because it
 * polls, so anything sent during the gap is waiting on Telegram's side when the
 * poller returns; Teams is not.
 *
 * The first version of the restart message made this worse by inviting exactly
 * the thing that gets lost: "Restarting now. Give me a minute, then say hello."
 * On havn-test the hellos arrived at 16:26:47 and 16:26:48, nine seconds before
 * the process came back, and both were 502ed and never seen. So the assistant
 * now asks the client to wait and speaks first when it is back.
 *
 * The note survives the restart in app_state, which lives in store/ and is
 * preserved by every update path.
 */
export const RESTART_NOTICE_KEY = 'restart_notice'

export interface RestartNotice {
  /** The chat that asked for the restart, and is owed the news. */
  chatId: string
  toVersion: string
}

export function rememberRestartNotice(
  notice: RestartNotice,
  setState: (k: string, v: string) => void = setAppState
): void {
  setState(RESTART_NOTICE_KEY, JSON.stringify(notice))
}

/**
 * The pending notice, if any. Reading does not clear it: the caller clears once
 * it has actually tried to deliver, so a crash between boot and send does not
 * swallow the only message that says the box is alive again.
 */
export function pendingRestartNotice(
  getState: (k: string) => string | null = getAppState
): RestartNotice | null {
  const raw = getState(RESTART_NOTICE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RestartNotice>
    if (!parsed.chatId) return null
    return { chatId: parsed.chatId, toVersion: parsed.toVersion ?? '' }
  } catch {
    return null
  }
}

/**
 * Clear it after the attempt, delivered or not. A notice that survived a failed
 * send would be announced on every boot from then on, which is worse than one
 * missed line.
 */
export function clearRestartNotice(
  setState: (k: string, v: string) => void = setAppState
): void {
  setState(RESTART_NOTICE_KEY, '')
}

export function restartNoticeMessage(notice: RestartNotice): string {
  return notice.toVersion ? `Back, on v${notice.toVersion}. Go ahead.` : 'Back. Go ahead.'
}
