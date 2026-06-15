import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR, SCHEDULER_ENABLED } from './config.js'
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
      logger.info({ installed: syncResult.installed }, 'Installed missing always-on skills')
    }
  } catch (err) {
    logger.warn({ err }, 'Always-on skill sync at boot failed; continuing')
  }

  // Create platform adapter
  const adapter = await createAdapter()

  // Create bot (wires adapter to core logic)
  const bot = createBot(adapter)

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

    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Start HTTP server (voice / custom-LLM endpoint)
  startHttpServer()

  // Polling watchdog: if no activity for 30 min, exit for restart.
  // Only for polling-based platforms. Socket-based ones reconnect internally.
  if (platform === 'telegram') {
    const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000
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
        process.exit(43)
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
