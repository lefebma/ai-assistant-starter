import { logger } from '../logger.js'

const CONFLICT_EXIT_CODE = 42

export function isGetUpdatesConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { error_code?: number; errorCode?: number; description?: string; method?: string; message?: string }
  const code = e.error_code ?? e.errorCode
  if (code !== 409) return false
  const haystack = `${e.method ?? ''} ${e.description ?? ''} ${e.message ?? ''}`.toLowerCase()
  return haystack.includes('getupdates') || haystack.includes('conflict')
}

export function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { error_code?: number; errorCode?: number }
  return (e.error_code ?? e.errorCode) === 401
}

/**
 * Handler for grammY's bot.start() rejection. grammY rethrows on 409 (conflict)
 * and 401 (unauthorized), which kills polling but not the process unless caught.
 *
 * On 409: log a duplicate-poller diagnostic and exit 42 so launchd restarts us
 * with a fresh HTTP transport (Telegram releases the old session after ~50s).
 * On 401: token is bad, exit 1 (no point auto-restarting).
 * Anything else: log and exit 1.
 */
export function handlePollingTermination(err: unknown): never {
  if (isGetUpdatesConflict(err)) {
    logger.error(
      { err },
      'Telegram 409 Conflict on getUpdates — another poller is using this bot token (duplicate Umi instance? leftover dev session?). Exiting so launchd can restart with a fresh transport.'
    )
    process.exit(CONFLICT_EXIT_CODE)
  }
  if (isUnauthorized(err)) {
    logger.fatal({ err }, 'Telegram 401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or revoked')
    process.exit(1)
  }
  logger.fatal({ err }, 'bot.start() rejected unexpectedly; polling has stopped')
  process.exit(1)
}
