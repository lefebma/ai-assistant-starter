import { writeFileSync } from 'node:fs'
import { CronExpressionParser } from 'cron-parser'
import { getDueTasks, getAllTasks, getTask, updateTaskAfterRun, setTaskNextRun, deleteTask, pauseTask, markTaskRunning, clearTaskRun, getInterruptedTasks, markTaskInterrupted, type ScheduledTask } from './db.js'
import { runAgent, isChatLaneActive, markLane, clearLane } from './agent.js'
import { withActor } from './assurance/audit-trail.js'
import { jobRunKey, journalForRun, withRun, type JournalRow } from './assurance/effect-journal.js'
import { markRunUnknown } from './assurance/run-state.js'
import { taskGrant, withGrant } from './assurance/grant.js'
import { expandTaskPrompt } from './audit/schedule.js'
import { collectAudit, defaultAuditIO } from './audit/index.js'
import { buildAuditPrompt } from './audit/report.js'
import { logger } from './logger.js'
import { aiPausedForBackground, readAiLimit, recoveryDueAt } from './ai-limit.js'
import { dashboardDataFile } from './cockpit/paths.js'

type Sender = (chatId: string, text: string) => Promise<void>
type AgentResult = Awaited<ReturnType<typeof runAgent>>

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
export function continuationPrompt(prompt: string, why = 'because the AI service was overloaded'): string {
  return [
    `[retry] An earlier attempt at this scheduled job stopped partway ${why}.`,
    'Check what was already done before acting, and finish only what is left. Anything that already went out is recorded, and a repeat will be refused.',
    '',
    'The job:',
    prompt,
  ].join('\n')
}

// Runs in flight, keyed per run (not per task: a deferred retry and the next
// cron occurrence of the same task can overlap). /cancel, /schedule cancel,
// /schedule delete and shutdown abort the controller; the signal reaches
// runAgent, which stops the run and anything it delegated (card #232).
type RunningRun = { taskId: string; chatId: string; label: string; controller: AbortController }
const runningRuns = new Map<number, RunningRun>()
let nextRunId = 1

function registerRun(task: Pick<ScheduledTask, 'id' | 'chat_id'>, label: string): { runId: number; controller: AbortController } {
  const runId = nextRunId++
  const controller = new AbortController()
  runningRuns.set(runId, { taskId: task.id, chatId: task.chat_id, label, controller })
  return { runId, controller }
}

export interface ScheduledCancelResult {
  /** Labels of runs that were in flight and have been told to stop. */
  stopped: string[]
  /** Labels of pending overload retries that will no longer fire. */
  retriesCleared: string[]
  /** One-shot task ids paused by this cancel, so they don't re-fire. */
  pausedOneShots: string[]
}

const labelFor = (task: Pick<ScheduledTask, 'name' | 'prompt'>) => task.name ?? task.prompt.slice(0, 100)

function cancelWhere(match: (taskId: string, chatId: string) => boolean): ScheduledCancelResult {
  const stopped: string[] = []
  const retriesCleared: string[] = []
  const touched = new Set<string>()
  for (const run of runningRuns.values()) {
    if (match(run.taskId, run.chatId) && !run.controller.signal.aborted) {
      run.controller.abort()
      stopped.push(run.label)
      touched.add(run.taskId)
    }
  }
  let tasks: Map<string, ScheduledTask> | undefined
  const taskById = (id: string) => (tasks ??= new Map(getAllTasks().map((t) => [t.id, t]))).get(id)
  for (const taskId of [...deferredRetries.keys()]) {
    const task = taskById(taskId)
    if (!match(taskId, task?.chat_id ?? '')) continue
    cancelDeferredRetry(taskId)
    retriesCleared.push(task ? labelFor(task) : taskId)
    touched.add(taskId)
  }
  // Persist now, not when the stopped run unwinds: a restart in between would
  // otherwise find a stale RUNNING... row and could re-arm a cancelled one-shot.
  const pausedOneShots: string[] = []
  for (const taskId of touched) {
    const task = taskById(taskId)
    if (!task) continue
    updateTaskAfterRun(taskId, 'CANCELLED', task.next_run)
    if (task.run_once && task.status === 'active') {
      pauseTask(taskId)
      pausedOneShots.push(taskId)
    }
  }
  if (touched.size) logger.info({ stopped, retriesCleared, pausedOneShots }, 'Scheduled task runs cancelled')
  return { stopped, retriesCleared, pausedOneShots }
}

/** Stop every running scheduled task and pending retry that delivers to this chat. */
export function cancelScheduledForChat(chatId: string): ScheduledCancelResult {
  return cancelWhere((_taskId, taskChat) => taskChat === chatId)
}

/** Stop one task's run in flight and its pending retry. */
export function cancelScheduledTask(taskId: string): ScheduledCancelResult {
  return cancelWhere((id) => id === taskId)
}

/**
 * Shutdown: stop runs in flight, leave their rows alone. A one-shot stopped
 * this way runs again after the restart under the same run key, so anything
 * it already sent is refused rather than repeated (#229).
 */
export function abortAllScheduledRuns(): number {
  let n = 0
  for (const run of runningRuns.values()) {
    if (!run.controller.signal.aborted) {
      run.controller.abort()
      // The row keeps its run key, so the boot sweep finds it (card #234).
      try { markTaskInterrupted(run.taskId) } catch { /* the database may already be closed */ }
      n++
    }
  }
  return n
}

export function isScheduledTaskRunning(taskId: string): boolean {
  for (const run of runningRuns.values()) if (run.taskId === taskId) return true
  return false
}

const scopeOf = (task: Pick<ScheduledTask, 'id' | 'role'>) => (task.role ? { role: task.role, taskId: task.id } : undefined)

/** last_result of a one-shot the sweep re-queued; runDueTasks resumes it instead of starting over. */
export const RESUME_MARK = 'RESUMING: interrupted by a restart'
/** last_result while a resumed run is in flight. Cut off again, it is paused, not resumed a second time. */
const RESUMED_RUNNING = 'RUNNING... (resumed)'

export type SweptRun = {
  taskId: string
  label: string
  runKey: string | null
  /**
   * What happened to it: resumed now, left for its next scheduled time, left
   * alone because the owner paused it, or paused here because it was cut off
   * again after being resumed once (a job that takes the process down).
   */
  action: 'resumed' | 'next-run' | 'paused' | 'paused-again'
  /** Effects the journal shows as done, and ones whose outcome never came back. */
  done: JournalRow[]
  unconfirmed: JournalRow[]
  alerted: boolean
}

function describeEffect(r: JournalRow): string {
  const to = (JSON.parse(r.recipients) as string[]).join(', ')
  return to ? `${r.kind} to ${to}` : r.kind
}

/** The owner's alert for one cut-off run. Exported for tests. */
export function sweepMessage(r: Pick<SweptRun, 'label' | 'action' | 'done' | 'unconfirmed'>, cause: string, nextAt?: string): string {
  const lines = [`"${r.label}" was cut off ${cause}, so I can't tell whether it finished.`]
  if (r.done.length) lines.push(`Already went out: ${r.done.map(describeEffect).join('; ')}.`)
  if (r.unconfirmed.length) lines.push(`Started but never confirmed (check Sent before asking again): ${r.unconfirmed.map(describeEffect).join('; ')}.`)
  if (!r.done.length && !r.unconfirmed.length) lines.push('Nothing it sends was recorded as going out.')
  if (r.action === 'resumed') lines.push('Picking it up again now. Anything that already went out will not be sent twice.')
  else if (r.action === 'paused') lines.push('The task is paused, so I have not picked it up again.')
  else if (r.action === 'paused-again') lines.push('This is the second time in a row, so I have paused it. Resume it with /schedule resume once it is safe to run.')
  else lines.push(`It runs again at its next scheduled time${nextAt ? ` (${nextAt})` : ''}.`)
  return lines.join('\n')
}

/**
 * Boot: find runs a previous process left mid-way (card #234). Nothing runs
 * in this process yet, so every row still holding a run key was cut off: by
 * a crash (RUNNING...), a shutdown (INTERRUPTED) or a lost deferred retry
 * (DEFERRED). Each is marked unknown and the owner is told what the effect
 * journal shows. An active one-shot is re-queued under the same run key, so
 * the journal refuses repeats; it goes through getDueTasks and the live
 * grant like any run, so a task paused or re-roled since is obeyed. A
 * recurring run waits for its next occurrence instead of replaying this one.
 */
export async function sweepInterruptedRuns(send: Sender | null = sender): Promise<SweptRun[]> {
  const out: SweptRun[] = []
  for (const task of getInterruptedTasks()) {
    const label = labelFor(task)
    const runKey = task.run_key ?? (task.run_once ? jobRunKey(task.id, task.next_run, true) : null)
    const journal = runKey ? journalForRun(runKey) : []
    const done = journal.filter(r => r.status === 'done')
    const unconfirmed = journal.filter(r => r.status !== 'done')
    const last = task.last_result ?? ''
    const cause = last.startsWith('INTERRUPTED') ? 'by a restart'
      : last.startsWith('DEFERRED') ? 'by a restart while it waited to retry'
      : 'when the assistant stopped unexpectedly'
    const action: SweptRun['action'] = task.status !== 'active' ? 'paused'
      : last === RESUMED_RUNNING ? 'paused-again'
      : task.run_once ? 'resumed' : 'next-run'
    const nowS = Math.floor(Date.now() / 1000)
    if (action === 'paused-again') pauseTask(task.id)
    if (action === 'resumed') {
      updateTaskAfterRun(task.id, RESUME_MARK, nowS, runKey)
    } else {
      updateTaskAfterRun(task.id, `UNKNOWN: cut off ${cause}`, task.next_run)
      if (runKey) markRunUnknown(runKey, `cut off ${cause}`)
    }
    // A silent job with nothing recorded is housekeeping: log it, don't page the owner.
    const quiet = task.delivery_mode === 'silent' && !journal.length
    let alerted = false
    if (send && !quiet) {
      const nextAt = action === 'next-run' ? new Date(task.next_run * 1000).toLocaleString('en-CA', { timeZone: task.timezone, dateStyle: 'medium', timeStyle: 'short' }) : undefined
      try {
        await send(task.chat_id, sweepMessage({ label, action, done, unconfirmed }, cause, nextAt))
        alerted = true
      } catch (err) {
        logger.warn({ err, taskId: task.id }, 'Could not alert the owner about an interrupted run')
      }
    }
    logger.warn({ taskId: task.id, runKey, action, done: done.length, unconfirmed: unconfirmed.length, alerted }, 'Interrupted scheduled run found at boot')
    out.push({ taskId: task.id, label, runKey, action, done, unconfirmed, alerted })
  }
  return out
}

export function initScheduler(send: Sender): void {
  sender = send
  // Wrap in catch so a rejection can NEVER crash the process (unhandled promise → Node exit)
  pollTimer = setInterval(() => {
    runDueTasks().catch((err) => logger.error({ err }, 'Scheduler poll failed'))
  }, 60_000)
  logger.info('Scheduler initialized, polling every 60s')
  sweepInterruptedRuns(send)
    .catch((err) => logger.error({ err }, 'Interrupted-run sweep failed'))
    .then(() => runDueTasks())
    .catch((err) => logger.error({ err }, 'Initial scheduler run failed'))
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
function skipWhilePaused(task: ScheduledTask, nextRun: number, midRun = false): void {
  if (task.run_once) {
    const nowMs = Date.now()
    const marker = readAiLimit()
    const at = marker ? recoveryDueAt(marker) : nowMs
    const retryAt = Math.ceil((at > nowMs ? at : nowMs + 15 * 60_000) / 1000)
    // Mid-run the row says RUNNING..., which the boot sweep would take for a crash (#234).
    if (midRun) updateTaskAfterRun(task.id, 'SKIPPED: AI allowance used up, trying again later', retryAt)
    else setTaskNextRun(task.id, retryAt)
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
    // The deferred retry and a rerun after a crash reuse this run key, so an
    // email the first attempt already sent is refused, not sent again (#229).
    const runKey = jobRunKey(task.id, task.next_run, task.run_once === 1)
    const resuming = task.last_result === RESUME_MARK
    markTaskRunning(task.id, runKey, nextRun, resuming ? RESUMED_RUNNING : undefined)
    markLane(task.chat_id, 'cron')
    const { runId, controller } = registerRun(task, label)
    let deferred = false

    try {
      // Only announce for non-silent jobs
      if (sender && !isSilent) {
        await sender(task.chat_id, `Running: ${label}...`)
      }

      // Task prompts are frozen in SQLite at creation, so a job that needs
      // current data carries a token instead of the data. Today that is only
      // the monthly audit; expandTaskPrompt is a no-op for every other job.
      const expanded = expandTaskPrompt(task.prompt, () =>
        buildAuditPrompt(collectAudit(task.chat_id, defaultAuditIO()))
      )
      // Picked up after a restart cut it off (card #234): tell the model so.
      const prompt = resuming ? continuationPrompt(expanded, 'because the assistant restarted') : expanded
      // Every tool call rereads the task (card #230): pausing, deleting or
      // re-roling the job takes effect at the next call, not the next run.
      const grant = taskGrant(task.id, getTask)
      const { text, aiPaused, newSessionId } = await withActor(`job:${task.id}`, () => withRun(runKey, () => withGrant(grant, () => runAgent(prompt, undefined, undefined, undefined, undefined, 'cron', controller.signal, scopeOf(task)))))
      // Cancelled: cancelWhere already recorded it and the command already
      // replied. Nothing to deliver, defer or delete.
      if (controller.signal.aborted) {
        logger.info({ taskId: task.id, name: task.name }, 'Cancelled scheduled run stopped')
        continue
      }
      // The allowance ran out during this run: nothing to send, keep a one-shot.
      if (aiPaused) {
        logger.info({ taskId: task.id, kind: aiPaused }, 'AI allowance used up during scheduled task')
        skipWhilePaused(task, nextRun, true)
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
            markTaskRunning(task.id, runKey, nextRun, 'RUNNING... (retry)')
            const retry = registerRun(now, label)
            let retryText: AgentResult['text']
            let retryPaused: AgentResult['aiPaused']
            try {
              ({ text: retryText, aiPaused: retryPaused } = await withActor(`job:${task.id}`, () => withRun(runKey, () => withGrant(grant, () => runAgent(continuationPrompt(prompt), newSessionId, undefined, undefined, undefined, 'cron', retry.controller.signal, scopeOf(now))))))
            } finally {
              runningRuns.delete(retry.runId)
              // Shutdown keeps the key for the boot sweep; a cancel already cleared it.
              if (!retry.controller.signal.aborted) clearTaskRun(task.id, runKey)
            }
            if (retry.controller.signal.aborted) {
              logger.info({ taskId: task.id }, 'Cancelled deferred retry stopped')
              return
            }
            if (retryPaused) {
              logger.info({ taskId: task.id, kind: retryPaused }, 'AI allowance used up during deferred retry')
              skipWhilePaused(task, nextRun, true)
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
        deferred = true

        // Don't send the overload message to the user. The run key stays: a
        // restart before the retry fires loses the timer, and the sweep finds it.
        updateTaskAfterRun(task.id, 'DEFERRED: API overloaded, retrying in 10 min', nextRun, runKey)
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
      runningRuns.delete(runId)
      clearLane(task.chat_id)
      // Every final outcome already cleared it; this catches any path that ends
      // without one. A pending retry still owes the run, and shutdown keeps it
      // for the boot sweep.
      if (!deferred && !controller.signal.aborted) {
        try { clearTaskRun(task.id, runKey) } catch { /* best effort */ }
      }
    }
  }

  syncDashboardJobs()
}

export function computeNextRun(cronExpression: string, timezone?: string): number {
  const opts = timezone ? { tz: timezone } : {}
  const expr = CronExpressionParser.parse(cronExpression, opts)
  return Math.floor(expr.next().getTime() / 1000)
}
