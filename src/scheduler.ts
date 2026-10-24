import { writeFileSync } from 'node:fs'
import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, getAllTasks, getTask, updateTaskAfterRun, setTaskNextRun, deleteTask, type ScheduledTask } from './db.js'
import { runAgent, isChatLaneActive, markLane, clearLane } from './agent.js'
import { withActor } from './assurance/audit-trail.js'
import { jobRunKey, withRun } from './assurance/effect-journal.js'
import { taskGrant, withGrant } from './assurance/grant.js'
import { expandTaskPrompt } from './audit/schedule.js'
import { collectAudit, defaultAuditIO } from './audit/index.js'
import { buildAuditPrompt } from './audit/report.js'
import { logger } from './logger.js'
import { aiPausedForBackground, readAiLimit, recoveryDueAt } from './ai-limit.js'
import { dashboardDataFile } from './cockpit/paths.js'

type Sender = (chatId: string, text: string) => Promise<void>

let sender: Sender | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

const SUPPRESSION_PATTERNS = ['HEARTBEAT_OK', 'NO_REPLY', 'NO_ACTION', 'NOTHING_TO_REPORT']
const OVERLOAD_PATTERN = /API is temporarily overloaded/i
const RETRY_DELAY_MS = 10 * 60 * 1000 // 10 minutes
const DASHBOARD_JOBS_FILE = process.env.DASHBOARD_JOBS_FILE || dashboardDataFile('scheduled-jobs.json')

// Track deferred retries: taskId -> timeout handle
const deferredRetries = new Map<string, ReturnType<typeof setTimeout>>()

/** Drop a task's pending overload retry, if it has one (pause and delete call this). */
export function cancelDeferredRetry(taskId: string): boolean {
  const handle = deferredRetries.get(taskId)
  if (!handle) return false
  clearTimeout(handle)
  deferredRetries.delete(taskId)
  logger.info({ taskId }, 'Deferred retry cancelled')
  return true
}

/**
 * What the deferred retry sends instead of the bare prompt (card #230). It
 * resumes the first attempt's session where there is one, so the model sees
 * what it already did; the effect journal (#229) refuses any repeat anyway.
 */
export function continuationPrompt(prompt: string): string {
  return [
    '[retry] An earlier attempt at this scheduled job stopped partway because the AI service was overloaded.',
    'Check what was already done before acting, and finish only what is left. Anything that already went out is recorded, and a repeat will be refused.',
    '',
    'The job:',
    prompt,
  ].join('\n')
}

const scopeOf = (task: Pick<ScheduledTask, 'id' | 'role'>) => (task.role ? { role: task.role, taskId: task.id } : undefined)

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
  if (!DASHBOARD_JOBS_FILE) return // dashboard integration off
  try {
    const tasks = getAllTasks()
    const jobs = tasks.map((t) => ({
      id: t.id,
      name: t.name ?? t.prompt.slice(0, 60),
      description: '',
      schedule: t.schedule,
      scheduleHuman: `${t.schedule} (${t.timezone})`,
      enabled: t.status === 'active',
      oneTime: t.run_once === 1,
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

/**
 * While the AI allowance is used up: a recurring task is marked skipped and
 * moves to its next cron time; a one-shot is kept and retried when recovery
 * is due (or in 15 minutes), since its next cron occurrence is about a year out.
 */
function skipWhilePaused(task: ScheduledTask, nextRun: number): void {
  if (task.run_once) {
    const nowMs = Date.now()
    const marker = readAiLimit()
    const at = marker ? recoveryDueAt(marker) : nowMs
    setTaskNextRun(task.id, Math.ceil((at > nowMs ? at : nowMs + 15 * 60_000) / 1000))
    return
  }
  updateTaskAfterRun(task.id, 'SKIPPED: AI allowance used up', nextRun)
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
    // AI allowance used up (a marker exists, even with recovery due: the
    // recovery timer probes, never a scheduled task). Advance the schedule
    // without running or announcing.
    if (aiPausedForBackground()) {
      logger.info({ taskId: task.id }, 'AI allowance used up, skipping scheduled task')
      skipWhilePaused(task, nextRun)
      continue
    }
    updateTaskAfterRun(task.id, 'RUNNING...', nextRun)
    markLane(task.chat_id, 'cron')

    try {
      // Only announce for non-silent jobs
      if (sender && !isSilent) {
        await sender(task.chat_id, `Running: ${label}...`)
      }

      // Task prompts are frozen in SQLite at creation, so a job that needs
      // current data carries a token instead of the data. Today that is only
      // the monthly audit; expandTaskPrompt is a no-op for every other job.
      const prompt = expandTaskPrompt(task.prompt, () =>
        buildAuditPrompt(collectAudit(task.chat_id, defaultAuditIO()))
      )

      // The deferred retry and a rerun after a crash reuse this run key, so an
      // email the first attempt already sent is refused, not sent again (#229).
      const runKey = jobRunKey(task.id, task.next_run, task.run_once === 1)
      // Every tool call rereads the task (card #230): pausing, deleting or
      // re-roling the job takes effect at the next call, not the next run.
      const grant = taskGrant(task.id, getTask)
      const { text, aiPaused, newSessionId } = await withActor(`job:${task.id}`, () => withRun(runKey, () => withGrant(grant, () => runAgent(prompt, undefined, undefined, undefined, undefined, 'cron', undefined, scopeOf(task)))))
      // The allowance ran out during this run: nothing to send, keep a one-shot.
      if (aiPaused) {
        logger.info({ taskId: task.id, kind: aiPaused }, 'AI allowance used up during scheduled task')
        skipWhilePaused(task, nextRun)
        continue
      }
      const result = text ?? '(no response)'

      // Check if the API was overloaded and defer a retry
      if (OVERLOAD_PATTERN.test(result) && !deferredRetries.has(task.id)) {
        logger.info({ taskId: task.id, retryIn: RETRY_DELAY_MS }, 'API overloaded, deferring retry in 10 min')
        const retryHandle = setTimeout(async () => {
          deferredRetries.delete(task.id)
          try {
            // The task as it is now, not as the first attempt saw it (card #230).
            const now = getTask(task.id)
            if (!now || now.status !== 'active') {
              logger.info({ taskId: task.id, reason: now ? 'paused' : 'deleted' }, 'Deferred retry dropped: the task changed since the first attempt')
              if (now) updateTaskAfterRun(task.id, 'SKIPPED: retry dropped, the task was paused', nextRun)
              return
            }
            logger.info({ taskId: task.id, resume: Boolean(newSessionId), role: now.role }, 'Running deferred retry')
            const { text: retryText, aiPaused: retryPaused } = await withActor(`job:${task.id}`, () => withRun(runKey, () => withGrant(grant, () => runAgent(continuationPrompt(prompt), newSessionId, undefined, undefined, undefined, 'cron', undefined, scopeOf(now)))))
            if (retryPaused) {
              logger.info({ taskId: task.id, kind: retryPaused }, 'AI allowance used up during deferred retry')
              skipWhilePaused(task, nextRun)
              return
            }
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

            // One-shot tasks self-delete once the retry actually completed
            if (task.run_once && !OVERLOAD_PATTERN.test(retryResult)) {
              deleteTask(task.id)
              logger.info({ taskId: task.id, name: task.name }, 'One-shot task completed (deferred retry) and deleted')
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

      // One-shot tasks self-delete after a completed run so they never re-fire
      if (task.run_once) {
        deleteTask(task.id)
        logger.info({ taskId: task.id, name: task.name }, 'One-shot task completed and deleted')
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
