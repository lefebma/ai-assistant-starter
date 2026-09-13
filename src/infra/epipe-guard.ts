import { logger } from '../logger.js'

/**
 * True for the one uncaught error the assistant can safely survive: an
 * asynchronous EPIPE from writing to a child process that has already exited.
 *
 * Why it exists: the Claude Agent SDK (0.2.x) writes to the CLI subprocess's
 * stdin without an 'error' listener. When a turn is cancelled (live voice
 * superseding a request when the user corrects themselves) the SDK kills the
 * child, and a write still in flight fails asynchronously with EPIPE. That
 * escapes every try/catch and, unhandled, takes the whole service down. The
 * turn itself already resolves through the abort path, so the error carries
 * nothing to act on.
 */
export function isBrokenChildPipe(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined
  return !!e && e.code === 'EPIPE' && e.syscall === 'write'
}

/**
 * Install once at startup. Everything other than a broken child pipe keeps
 * Node's default outcome: log it and exit non-zero so launchd restarts us.
 */
export function installEpipeGuard(exit: (code: number) => void = (code) => process.exit(code)): void {
  process.on('uncaughtException', (err) => {
    if (isBrokenChildPipe(err)) {
      logger.warn({ err: err.message }, 'Ignored EPIPE from an exited child process (cancelled agent turn)')
      return
    }
    logger.fatal({ err }, 'Uncaught exception, exiting')
    exit(1)
  })
}
