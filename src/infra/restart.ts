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
