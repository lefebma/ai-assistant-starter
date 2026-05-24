import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, getAllTasks, updateTaskAfterRun } from './db.js'
import { runAgent, isChatLaneActive, markLane, clearLane } from './agent.js'
import { logger } from './logger.js'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

const SUPPRESSION_PATTERNS = ['HEARTBEAT_OK', 'NO_REPLY', 'NO_ACTION', 'NOTHING_TO_REPORT']
const OVERLOAD_PATTERN = /API is temporarily overloaded/i
const RETRY_DELAY_MS = 10 * 60 * 1000 // 10 minutes
const DASHBOARD_JOBS_FILE = resolve(homedir(), 'clawd/dashboard-data/scheduled-jobs.json')

// Track deferred retries: taskId -> timeout handle
const deferredRetries = new Map<string, ReturnType<typeof setTimeout>>()

export function initScheduler(send: Sender): void {
  sender = send
  // Wrap in catch so a rejection can NEVER crash the process (unhandled promise → Node exit)
  pollTimer = setInterval(() => {
    runDueTasks().catch((err) => logger.error({ err }, 'Scheduler poll failed'))
  }, 60_000)
  logger.info('Scheduler initialized, polling every 60s')
  runDueTasks().catch((err) => logger.error({ err }, 'Initial scheduler run failed'))
}

export function stopScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function shouldSuppressResult(result: string): boolean {
  const trimmed = result.trim()
  return SUPPRESSION_PATTERNS.some((p) => trimmed.includes(p))
}

function syncDashboardJobs(): void {
  try {
    const tasks = getAllTasks()
    const jobs = tasks.map((t) => ({
      id: t.id,
      name: t.name ?? t.prompt.slice(0, 60),
      description: '',
      schedule: t.schedule,
      scheduleHuman: `${t.schedule} (${t.timezone})`,
      enabled: t.status === 'active',
      oneTime: false,
      nextRun: t.next_run ? new Date(t.next_run * 1000).toISOString() : null,
      lastRun: t.last_run ? new Date(t.last_run * 1000).toISOString() : null,
      lastStatus: t.last_result ? 'ok' : null,
      lastDurationMs: null,
      lastResult: t.last_result ? t.last_result.slice(0, 200) : null,
    }))
    const output = { lastUpdated: new Date().toISOString(), jobs }
    writeFileSync(DASHBOARD_JOBS_FILE, JSON.stringify(output, null, 2))
    logger.debug('Dashboard jobs synced')
  } catch (err) {
    logger.warn({ err }, 'Failed to sync dashboard jobs')
  }
}

export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks()
  if (tasks.length === 0) return

  logger.info({ count: tasks.length }, 'Running due scheduled tasks')

  for (const task of tasks) {
    const isSilent = task.delivery_mode === 'silent'
    const label = task.name ?? task.prompt.slice(0, 100)

    // Cron wake-lane isolation (OpenClaw v2026.5.19): if the chat has an active
    // live conversation, defer this task to the next poll rather than competing
    // for the agent and potentially stalling the user's interaction.
    if (isChatLaneActive(task.chat_id)) {
      logger.info({ taskId: task.id, chatId: task.chat_id }, 'Chat lane active, deferring cron task')
      continue
    }

    // Immediately advance next_run to prevent duplicate execution
    // if another poll happens while the agent is running
    let nextRun: number
    try {
      nextRun = computeNextRun(task.schedule, task.timezone)
    } catch (err) {
      logger.error({ err, taskId: task.id, schedule: task.schedule }, 'Invalid cron, skipping task (parking 24h)')
      // Park for 24h so the broken task doesn't block the queue or re-fire every poll
      updateTaskAfterRun(task.id, `ERROR: invalid schedule "${task.schedule}"`, Math.floor(Date.now() / 1000) + 86400)
      continue
    }
    updateTaskAfterRun(task.id, 'RUNNING...', nextRun)
    markLane(task.chat_id, 'cron')

    try {
      // Only announce for non-silent jobs
      if (sender && !isSilent) {
        await sender(task.chat_id, `Running: ${label}...`)
      }

      const { text } = await runAgent(task.prompt)
      const result = text ?? '(no response)'

      // Check if the API was overloaded and defer a retry
      if (OVERLOAD_PATTERN.test(result) && !deferredRetries.has(task.id)) {
        logger.info({ taskId: task.id, retryIn: RETRY_DELAY_MS }, 'API overloaded, deferring retry in 10 min')
        const retryHandle = setTimeout(async () => {
          deferredRetries.delete(task.id)
          try {
            logger.info({ taskId: task.id }, 'Running deferred retry')
            const { text: retryText } = await runAgent(task.prompt)
            const retryResult = retryText ?? '(no response)'
            updateTaskAfterRun(task.id, retryResult, nextRun)

            if (sender && !OVERLOAD_PATTERN.test(retryResult)) {
              if (isSilent && shouldSuppressResult(retryResult)) {
                logger.info({ taskId: task.id }, 'Deferred retry suppressed (silent)')
              } else {
                await sender(task.chat_id, `${label}:\n\n${retryResult}`)
              }
            } else if (sender && OVERLOAD_PATTERN.test(retryResult)) {
              logger.warn({ taskId: task.id }, 'Deferred retry also overloaded, giving up')
              // Don't spam the user, just log it
            }
          } catch (err) {
            logger.error({ err, taskId: task.id }, 'Deferred retry failed')
          }
        }, RETRY_DELAY_MS)
        deferredRetries.set(task.id, retryHandle)

        // Don't send the overload message to the user
        updateTaskAfterRun(task.id, 'DEFERRED: API overloaded, retrying in 10 min', nextRun)
        logger.info({ taskId: task.id, name: task.name, nextRun }, 'Scheduled task deferred')
        continue
      }

      // Update with actual result (next_run already set)
      updateTaskAfterRun(task.id, result, nextRun)

      if (sender) {
        if (isSilent && shouldSuppressResult(result)) {
          logger.info({ taskId: task.id, name: task.name }, 'Silent task suppressed')
        } else if (isSilent) {
          // Silent mode but has actionable content
          await sender(task.chat_id, `${label}:\n\n${result}`)
        } else {
          // Announce mode
          await sender(task.chat_id, `${label}:\n\n${result}`)
        }
      }

      logger.info({ taskId: task.id, name: task.name, nextRun }, 'Scheduled task completed')
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed')
      if (sender) {
        await sender(task.chat_id, `Scheduled task "${label}" failed: ${String(err)}`)
      }
      // Still advance next_run so a broken task doesn't block the queue
      try {
        const nextRun = computeNextRun(task.schedule, task.timezone)
        updateTaskAfterRun(task.id, `ERROR: ${String(err)}`, nextRun)
      } catch { /* best effort */ }
    } finally {
      clearLane(task.chat_id)
    }
  }

  syncDashboardJobs()
}

export function computeNextRun(cronExpression: string, timezone?: string): number {
  const opts = timezone ? { tz: timezone } : {}
  const expr = CronExpressionParser.parse(cronExpression, opts)
  return Math.floor(expr.next().getTime() / 1000)
}
