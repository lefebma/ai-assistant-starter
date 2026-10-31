import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR, SCHEDULER_ENABLED, PRIMARY_CHAT_ID, UPDATE_NOTICE_ENABLED, AUDIT_DIR, AUDIT_WITNESS_URL, AUDIT_WITNESS_TOKEN } from './config.js'
import { getAuditTrail } from './assurance/audit-trail.js'
import { WitnessShipper, startWitnessShipping } from './assurance/witness.js'
import { WitnessChecker, startWitnessChecks } from './assurance/witness-check.js'
import { initDatabase } from './db.js'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { abortAllRuns, createBot } from './bot.js'
import { initScheduler, stopScheduler } from './scheduler.js'
import { AiPausedError } from './ai-limit.js'
import { startAiRecovery } from './ai-recovery.js'
import { reconcileManagedKey } from './managed-ai-cli.js'
import { getSecret } from './vault/index.js'
import { sendTextWithFiles } from './outbound-delivery.js'
import { initWorkspaceService, stopWorkspaceService, defaultSyncOne } from './workspace/service.js'
import { initUpdateNotice, stopUpdateNotice } from './update/notice-service.js'
import { checkForUpdate, getChangelog, restartPending } from './updater.js'
import { startHttpServer, stopHttpServer } from './http-server.js'
import { pruneVoiceTranscripts } from './voice-history.js'
import { stopChrome, isCdpAvailable } from './browser.js'
import { runBestEffortCleanup, withTimeout } from './infra/cleanup.js'
import { createAdapter, detectPlatform } from './platform/index.js'
import { syncAlwaysOnSkills } from './skills/sync.js'
import { reloadSkills } from './skills/index.js'
import { interviewGreeting, markInterviewOffered, shouldOfferInterview } from './onboarding/interview-offer.js'
import { markWelcomeGreeted, shouldGreetWelcome, welcomeGreeting } from './onboarding/welcome.js'
import { PROVISIONAL, isProfilePending, loadSetupAnswers } from './setup/saved.js'
import { auditWanted, ensureAuditTask } from './audit/index.js'
import { auditScheduleDeps } from './audit/wiring.js'
import { readEnvFile, installTimezone } from './env.js'
import { startEmailAlerts } from './email-alerts/service.js'
import { discoverMailboxes } from './email-alerts/sources.js'
import { triage as triageEmail, withTimeout as withTriageTimeout } from './email-alerts/triage.js'
import { localDay } from './email-alerts/rules.js'
import { outlookClient } from './email-alerts/sources.js'
import { listAuthedAccounts } from './ms/store.js'
import { startProactive } from './proactive/service.js'
import { discoverCalendars } from './proactive/calendar.js'
import { relatedThreads } from './proactive/threads.js'
import { DAILY_DECISION_CAP, decide as decideBriefing } from './proactive/decide.js'
import { arrivalNotes } from './proactive/travel.js'
import { bumpCallCount, callCount } from './proactive/store.js'
import { getAgentRuntime } from './runtime/index.js'
import { PROJECT_ROOT } from './env.js'
import { clearRestartNotice, pendingRestartNotice, restartNoticeMessage, shutdownExitCode } from './infra/restart.js'
import { RESTART_EXIT_CODE } from './service/supervisor.js'
import { logger } from './logger.js'
import { installEpipeGuard } from './infra/epipe-guard.js'

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

  // Managed box on a key that is not the provider's (card #160): the client
  // brought their own, so caps and the operator's alerts stop.
  try {
    if (reconcileManagedKey(getSecret('ANTHROPIC_API_KEY'), STORE_DIR) === 'dropped') {
      logger.warn('The AI key is not the managed one; managed mode is off')
    }
  } catch (err) {
    logger.warn({ err }, 'Managed key check at boot failed; continuing')
  }

  // Run initial memory decay sweep + schedule daily
  runDecaySweep()
  const decayTimer = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // Off-box copy of the audit log (card #196). Off unless a witness is configured.
  const stopWitness = AUDIT_WITNESS_URL && AUDIT_WITNESS_TOKEN
    ? startWitnessShipping(() => {
        const trail = getAuditTrail(AUDIT_DIR, PROJECT_ROOT)
        return trail ? new WitnessShipper({ log: trail.log, url: AUDIT_WITNESS_URL, token: AUDIT_WITNESS_TOKEN }) : null
      })
    : () => {}

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

  // A minimal setup greets with the profile questions instead, once, marked
  // only on a successful send. The greeting is not one of the welcome turns:
  // those count inbound replies (bot.ts). While pending, the interview
  // greeting stays suppressed even once this one has been sent.
  if (PRIMARY_CHAT_ID && isProfilePending(PROJECT_ROOT)) {
    if (shouldGreetWelcome(PROJECT_ROOT)) {
      const saved = loadSetupAnswers(PROJECT_ROOT)
      const ownerName = typeof saved?.ownerName === 'string' ? saved.ownerName : PROVISIONAL.ownerName
      const assistantName =
        typeof saved?.assistantName === 'string' && saved.assistantName.trim() ? saved.assistantName.trim() : PROVISIONAL.assistantName
      try {
        await adapter.sendMessage(PRIMARY_CHAT_ID, welcomeGreeting(ownerName, assistantName))
        markWelcomeGreeted()
        logger.info('Sent the welcome questions on startup')
      } catch (err) {
        logger.info({ err }, 'Could not greet on startup; the questions ride the first inbound message')
      }
    }
  } else if (PRIMARY_CHAT_ID && shouldOfferInterview(PROJECT_ROOT)) {
    try {
      await adapter.sendMessage(PRIMARY_CHAT_ID, interviewGreeting())
      markInterviewOffered()
      logger.info('Offered the discovery interview on startup')
    } catch (err) {
      logger.info({ err }, 'Could not greet on startup; the offer rides the first inbound message')
    }
  }

  // The setup wizard records the monthly-audit preference in .env, because it
  // runs before the owner has messaged their bot and there is no chat to
  // schedule against yet. Seed it here, once ever: an owner who later deletes
  // the task has said something, and a box that recreates it on every boot is
  // not listening.
  if (PRIMARY_CHAT_ID) {
    try {
      const result = ensureAuditTask(PRIMARY_CHAT_ID, auditWanted(readEnvFile(['MONTHLY_AUDIT'])), auditScheduleDeps())
      if (result === 'created') logger.info('Scheduled the monthly assistant audit')
    } catch (err) {
      logger.warn({ err }, 'Could not seed the monthly audit task')
    }
  }

  // Initialize scheduler
  if (SCHEDULER_ENABLED) {
    // Same [[file:]] handling as an interactive reply, so a scheduled job can
    // attach the chart or the PDF it just produced.
    initScheduler((chatId, text) => sendTextWithFiles(adapter, chatId, text))
    logger.info('Scheduler enabled')
  }

  initWorkspaceService({
    syncOne: defaultSyncOne,
    notify: async (text) => {
      if (PRIMARY_CHAT_ID) await adapter.sendMessage(PRIMARY_CHAT_ID, text)
    },
  })

  // Hourly check of the off-box copy (card #196). Problems go to the owner on
  // whichever platform this box talks on: Telegram, or Teams, where a
  // Telegram-only path never reached anyone (found in the part 4 drill).
  const stopWitnessChecks = AUDIT_WITNESS_URL && AUDIT_WITNESS_TOKEN
    ? startWitnessChecks(() => {
        const trail = getAuditTrail(AUDIT_DIR, PROJECT_ROOT)
        return trail
          ? new WitnessChecker({
              log: trail.log, url: AUDIT_WITNESS_URL, token: AUDIT_WITNESS_TOKEN,
              // No owner chat: still check, so the witness keeps its heartbeat.
              notify: async (text) => {
                if (!PRIMARY_CHAT_ID) return false
                await adapter.sendMessage(PRIMARY_CHAT_ID, text)
                return true
              },
            })
          : null
      })
    : () => {}

  // Critical-email alerts. Off until the owner turns them on in chat; the
  // tick is a no-op while disabled. Without an owner chat there is nobody to
  // alert, so it does not start at all.
  const emailAlertsTz = installTimezone()
  const stopEmailAlerts = PRIMARY_CHAT_ID
    ? startEmailAlerts({
        boxes: () => discoverMailboxes(),
        triage: (i) =>
          triageEmail(i, {
            run: withTriageTimeout(async (message, signal) => {
              const r = await getAgentRuntime('cron').run({ message, model: 'haiku', isolated: true, signal })
              // The allowance ran out on this mail: triage reports paused and
              // the tick stops before marking the rest seen.
              if (r.aiPaused) throw new AiPausedError(r.aiPaused)
              return r.text
            }),
            day: localDay(new Date(), emailAlertsTz),
          }),
        send: async (text, buttons) => {
          const messageId = await adapter.sendMessage(
            PRIMARY_CHAT_ID,
            text,
            buttons && adapter.supportsButtons ? { buttons } : undefined
          )
          return { chatId: PRIMARY_CHAT_ID, messageId }
        },
        now: () => new Date(),
        tz: emailAlertsTz,
        // Telegram sends alerts as plain text, so markdown escapes would show.
        format: adapter.name === 'telegram' ? 'plain' : 'markdown',
      })
    : () => {}

  // Meeting briefings and travel messages (cards #258, #259, #260). Off until
  // the owner turns them on; the tick is a no-op while disabled. Same rule as email alerts:
  // no owner chat, nobody to brief, so it does not start.
  const proactiveRun = withTriageTimeout(async (message, signal) => {
    const r = await getAgentRuntime('cron').run({ message, model: 'haiku', isolated: true, signal })
    if (r.aiPaused) throw new AiPausedError(r.aiPaused)
    return r.text
  })
  const stopProactive = PRIMARY_CHAT_ID
    ? startProactive({
        calendars: () => discoverCalendars({ msAccounts: () => listAuthedAccounts(), client: outlookClient }),
        threads: (event, own, nowMs) => relatedThreads(event, own, nowMs, { client: outlookClient }),
        decide: (event, threads) =>
          decideBriefing(event, threads, {
            run: proactiveRun,
            tz: emailAlertsTz,
            count: () => callCount(localDay(new Date(), emailAlertsTz)),
            bump: () => bumpCallCount(localDay(new Date(), emailAlertsTz)),
          }),
        // Arrival notes share the briefings' daily cap of model reads.
        notes: (event, place, threads) =>
          arrivalNotes(event, place, threads, {
            run: proactiveRun,
            tz: emailAlertsTz,
            count: () => callCount(localDay(new Date(), emailAlertsTz)),
            bump: () => bumpCallCount(localDay(new Date(), emailAlertsTz)),
            cap: DAILY_DECISION_CAP,
          }),
        send: async (text) => {
          const messageId = await adapter.sendMessage(PRIMARY_CHAT_ID, text)
          return { chatId: PRIMARY_CHAT_ID, messageId }
        },
        now: () => new Date(),
        tz: emailAlertsTz,
        format: adapter.name === 'telegram' ? 'plain' : 'markdown',
      })
    : () => {}

  // Managed box only: the single background recovery probe while the AI
  // allowance is used up. Not started anywhere else.
  const stopAiRecovery = startAiRecovery()

  // Tell the owner once when a release lands. Without a chat to speak into
  // there is nobody to tell, so it does not start at all.
  if (PRIMARY_CHAT_ID && UPDATE_NOTICE_ENABLED) {
    initUpdateNotice({
      check: () => checkForUpdate(false),
      changelog: getChangelog,
      restartPending: () => restartPending(),
      notify: async (text) => {
        await adapter.sendMessage(PRIMARY_CHAT_ID, adapter.formatText(text))
      },
    })
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

    // Stop chat turns and scheduled runs first (card #232): their tools and
    // subagents are killed, not left running against a process on its way out.
    abortAllRuns()
    clearInterval(decayTimer)
    stopWitness()
    stopWitnessChecks()
    stopEmailAlerts()
    stopProactive()
    stopAiRecovery()

    // The listener closes first, and the order is load-bearing on a hosted box.
    // While it stays open, a webhook arriving mid-shutdown is accepted and then
    // dropped, and the edge cannot retry a POST whose connection it already
    // established: it answers 502 and that message is gone. Closed first, the
    // same webhook is refused outright, which the edge does retry
    // (lb_try_duration in the Caddyfile), so it arrives late instead of never.
    // Measured on havn-test: mid-flight close gave up after 3s with a 502,
    // refused connection held the full 15s and was answered by the new process.
    // close() lets requests already in flight finish; it only stops new ones.
    await runBestEffortCleanup({
      name: 'http.stop',
      cleanup: () => withTimeout(stopHttpServer(), 2000, 'http.stop'),
    })
    await runBestEffortCleanup({
      name: 'adapter.stop',
      cleanup: () => withTimeout(adapter.stop(), 3000, 'adapter.stop'),
    })
    await runBestEffortCleanup({ name: 'scheduler.stop', cleanup: () => stopScheduler() })
    await runBestEffortCleanup({ name: 'workspace.stop', cleanup: () => stopWorkspaceService() })
    await runBestEffortCleanup({ name: 'updateNotice.stop', cleanup: () => stopUpdateNotice() })
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
  installEpipeGuard()

  // Start HTTP server (voice / custom-LLM endpoint)
  startHttpServer()
  try {
    pruneVoiceTranscripts()
  } catch (err) {
    logger.warn({ err }, 'voice transcript prune failed')
  }

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
