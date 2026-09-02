import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR, SCHEDULER_ENABLED, PRIMARY_CHAT_ID } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { startHttpServer, stopHttpServer } from './http-server.js'
import { stopChrome, isCdpAvailable } from './browser.js'
import { runBestEffortCleanup, withTimeout } from './infra/cleanup.js'
import { createAdapter, detectPlatform } from './platform/index.js'
import { syncAlwaysOnSkills } from './skills/sync.js'
import { reloadSkills } from './skills/index.js'
import { interviewGreeting, markInterviewOffered, shouldOfferInterview } from './onboarding/interview-offer.js'
import { PROJECT_ROOT } from './env.js'
import { clearRestartNotice, pendingRestartNotice, restartNoticeMessage, shutdownExitCode } from './infra/restart.js'
import { RESTART_EXIT_CODE } from './service/supervisor.js'
import { logger } from './logger.js'

const PID_FILE = resolve(STORE_DIR, 'assistant.pid')

const BANNER = `
 █████╗ ██╗    █████╗ ███████╗███████╗██╗███████╗████████╗ █████╗ ███╗   ██╗████████╗
██╔══██╗██║   ██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝██╔══██╗████╗  ██║╚══██╔══╝
███████║██║   ███████║███████╗███████╗██║███████╗   ██║   ███████║██╔██╗ ██║   ██║
██╔══██║██║   ██╔══██║╚════██║╚════██║██║╚════██║   ██║   ██╔══██║██║╚██╗██║   ██║
██║  ██║██║   ██║  ██║███████║███████║██║███████║   ██║   ██║  ██║██║ ╚████║   ██║
╚═╝  ╚═╝╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝
`

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0)
        logger.warn({ oldPid }, 'Killing previous instance')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // Process already dead, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.debug({ pid: process.pid }, 'PID lock acquired')
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE)
    }
  } catch {
    // Best effort
  }
}

async function main(): Promise<void> {
  // Offline install verification: no lock, no bot, no network. Used by the
  // installer's final step and the CI install smoke test.
  if (process.argv.includes('--selftest')) {
    const { runSelfTest } = await import('./selftest.js')
    const ok = await runSelfTest({
      skipAuth: process.argv.includes('--skip-auth'),
      live: process.argv.includes('--live'),
    })
    process.exit(ok ? 0 : 1)
  }

  console.log(BANNER)

  const platform = detectPlatform()
  logger.info({ platform }, 'Detected platform')

  // Acquire lock
  acquireLock()

  // Initialize database
  initDatabase()
  logger.info('Database initialized')

  // Run initial memory decay sweep + schedule daily
  runDecaySweep()
  const decayTimer = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // Cleanup old uploads
  cleanupOldUploads()

  // Sync always-on skills from templates/ (idempotent — only installs missing ones).
  // Catches clients who upgraded from a version that didn't auto-install them.
  try {
    const syncResult = syncAlwaysOnSkills()
    if (syncResult.installed.length > 0) {
      // The skill registry is built while bot.js is being imported, which
      // happens before main() runs, so a skill installed one line ago is on
      // disk and absent from the registry. Without this reload it stays
      // invisible until the NEXT restart: /skill list omits it, its triggers
      // never match, and the skill index does not mention it. That is exactly
      // what a client sees on the first boot after an update that adds an
      // always-on skill, which is the boot where they go looking for it.
      const skills = reloadSkills()
      logger.info(
        { installed: syncResult.installed, count: skills.length },
        'Installed missing always-on skills and reloaded the registry'
      )
    }
  } catch (err) {
    logger.warn({ err }, 'Always-on skill sync at boot failed; continuing')
  }

  // Create platform adapter
  const adapter = await createAdapter()

  // Create bot (wires adapter to core logic)
  const bot = createBot(adapter)

  // Introduce the discovery interview, once, to an install that has never run
  // one. The flag is set only on a successful send: Teams cannot send into a
  // conversation it has never heard from, and treating that failure as
  // "offered" would leave the client with no way to learn the interview
  // exists. Those installs get the offer on their first inbound message
  // instead (see handleMessage in bot.ts).
  // If we restarted to finish an update, the client was asked to wait. Tell
  // them it is over before anything else: they are holding a message.
  const notice = pendingRestartNotice()
  if (notice) {
    try {
      await adapter.sendMessage(notice.chatId, restartNoticeMessage(notice))
      logger.info({ to: notice.toVersion }, 'Told the client the restart is done')
    } catch (err) {
      logger.warn({ err }, 'Could not announce the restart; carrying on')
    } finally {
      // Cleared either way. A notice that outlived a failed send would be
      // announced on every boot from here on.
      clearRestartNotice()
    }
  }

  if (PRIMARY_CHAT_ID && shouldOfferInterview(PROJECT_ROOT)) {
    try {
      await adapter.sendMessage(PRIMARY_CHAT_ID, interviewGreeting())
      markInterviewOffered()
      logger.info('Offered the discovery interview on startup')
    } catch (err) {
      logger.info({ err }, 'Could not greet on startup; the offer rides the first inbound message')
    }
  }

  // Initialize scheduler
  if (SCHEDULER_ENABLED) {
    initScheduler(async (chatId, text) => {
      const formatted = adapter.formatText(text)
      const chunks = adapter.splitMessage(formatted)
      for (const chunk of chunks) {
        try {
          await adapter.sendMessage(chatId, chunk, { parseMode: 'html' })
        } catch {
          await adapter.sendMessage(chatId, chunk)
        }
      }
    })
    logger.info('Scheduler enabled')
  }

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down...')

    const hardExit = setTimeout(() => {
      logger.warn('Shutdown deadline exceeded; forcing exit')
      process.exit(1)
    }, 8000)
    hardExit.unref()

    clearInterval(decayTimer)

    await runBestEffortCleanup({
      name: 'adapter.stop',
      cleanup: () => withTimeout(adapter.stop(), 3000, 'adapter.stop'),
    })
    await runBestEffortCleanup({ name: 'scheduler.stop', cleanup: () => stopScheduler() })
    await runBestEffortCleanup({
      name: 'http.stop',
      cleanup: () => withTimeout(stopHttpServer(), 2000, 'http.stop'),
    })
    if (await isCdpAvailable()) {
      await runBestEffortCleanup({ name: 'chrome.stop', cleanup: async () => stopChrome() })
    }
    await runBestEffortCleanup({ name: 'lock.release', cleanup: async () => releaseLock() })

    // Non-zero when a command asked for a restart, so a Restart=on-failure unit
    // brings us back rather than treating this as a clean stop.
    process.exit(shutdownExitCode())
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Start HTTP server (voice / custom-LLM endpoint)
  startHttpServer()

  // Polling watchdog: exit for restart once the poller goes quiet.
  // Only for polling-based platforms. Socket-based ones reconnect internally.
  //
  // "Activity" is a completed getUpdates round trip, not an inbound message
  // (see createPollActivityTransformer in platform/telegram.ts), so a healthy
  // poller checks in every ~30s no matter how quiet the chat is. That makes
  // the default threshold below a genuine liveness bound rather than a cap on
  // how long a user may stay silent before the box restarts itself.
  if (platform === 'telegram') {
    const WATCHDOG_TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MIN || 0) * 60_000 || 30 * 60_000
    let lastActivity = Date.now()

    adapter.onActivity(() => {
      lastActivity = Date.now()
    })

    const watchdogTimer = setInterval(() => {
      if (shuttingDown) return
      const silenceMs = Date.now() - lastActivity
      if (silenceMs > WATCHDOG_TIMEOUT_MS) {
        logger.error(
          { silenceMs, threshold: WATCHDOG_TIMEOUT_MS },
          'Polling watchdog: no activity, exiting for restart.'
        )
        process.exit(RESTART_EXIT_CODE)
      }
    }, 60_000)
    watchdogTimer.unref()
  }

  // Start the platform adapter and wire up bot commands
  await adapter.start()
  await bot.registerCommands()
  logger.info({ platform }, 'AI Assistant running')
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start AI Assistant')
  releaseLock()
  process.exit(1)
})
