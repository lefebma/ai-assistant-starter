import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, STORE_DIR, TELEGRAM_BOT_TOKEN, PRIMARY_CHAT_ID, SCHEDULER_ENABLED } from './config.js'
import { initDatabase } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { createBot } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { startHttpServer, stopHttpServer } from './http-server.js'
import { stopChrome, isCdpAvailable } from './browser.js'
import { runBestEffortCleanup, withTimeout } from './infra/cleanup.js'
import { handlePollingTermination } from './infra/telegram-conflict.js'
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
        process.kill(oldPid, 0) // Check if alive
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

  // Check config
  if (!TELEGRAM_BOT_TOKEN) {
    logger.fatal('TELEGRAM_BOT_TOKEN not set. Run "npm run setup" or add it to .env')
    process.exit(1)
  }
  if (!PRIMARY_CHAT_ID) {
    logger.warn(
      'ALLOWED_CHAT_ID not set in .env. Bot will respond to ALL chats. ' +
        'Send /chatid to the bot to get your ID, then add it to .env.'
    )
  }

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

  // Create bot
  const bot = createBot()

  // Initialize scheduler
  if (SCHEDULER_ENABLED) {
    const { sendTelegramMessage } = await import('./bot.js')
    initScheduler(async (chatId, text) => {
      await sendTelegramMessage(chatId, text)
    })
    logger.info('Scheduler enabled')
  }

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('Shutting down...')

    // Hard ceiling so a wedged step can't block exit forever.
    const hardExit = setTimeout(() => {
      logger.warn('Shutdown deadline exceeded; forcing exit')
      process.exit(1)
    }, 8000)
    hardExit.unref()

    clearInterval(decayTimer)

    await runBestEffortCleanup({
      name: 'bot.stop',
      cleanup: () => withTimeout(Promise.resolve(bot.stop()), 3000, 'bot.stop'),
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

  // Polling watchdog (inspired by OpenClaw v2026.5.7).
  // If no Telegram update arrives for WATCHDOG_TIMEOUT_MS, the poller is likely
  // wedged. Exit so launchd restarts with a fresh transport.
  // Outbound Bot API calls (sendMessage) can mask a wedged poller, so we
  // tie the heartbeat strictly to incoming update processing.
  const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000  // 30 minutes
  let lastPollingActivity = Date.now()

  const watchdogTimer = setInterval(() => {
    if (shuttingDown) return
    const silenceMs = Date.now() - lastPollingActivity
    if (silenceMs > WATCHDOG_TIMEOUT_MS) {
      logger.error(
        { silenceMs, threshold: WATCHDOG_TIMEOUT_MS },
        'Polling watchdog: no getUpdates activity, poller may be wedged. Exiting for restart.'
      )
      process.exit(43)  // Distinct code for watchdog kills
    }
  }, 60_000)
  watchdogTimer.unref()

  // Inject watchdog heartbeat as first middleware so every update touches it
  bot.use(async (_ctx, next) => {
    lastPollingActivity = Date.now()
    await next()
  })

  // Start the bot (long-polling). grammY rethrows on 401/409 which would
  // silently kill polling without exiting the process — handlePollingTermination
  // turns that into a clean exit so launchd restarts us with a fresh transport.
  bot.start().catch((err) => {
    if (shuttingDown) return
    handlePollingTermination(err)
  })
  logger.info('AI Assistant running (Telegram mode)')
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start AI Assistant')
  releaseLock()
  process.exit(1)
})
