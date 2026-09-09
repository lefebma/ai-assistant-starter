/**
 * The audit's scheduling dependencies, bound to the real store.
 *
 * Its own file so bot.ts and index.ts share one binding, and so the pure
 * scheduling rules in schedule.ts never import the database.
 */
import { randomUUID } from 'node:crypto'
import { createTask, getAllTasks, deleteTask, getAppState, setAppState } from '../db.js'
import { installTimezone } from '../env.js'
import { computeNextRun } from '../scheduler.js'
import type { AuditScheduleDeps } from './schedule.js'

export function auditScheduleDeps(): AuditScheduleDeps {
  return {
    getState: getAppState,
    setState: setAppState,
    listTasks: () =>
      getAllTasks().map((t) => ({
        id: t.id,
        chatId: t.chat_id,
        name: t.name,
        prompt: t.prompt,
        schedule: t.schedule,
        nextRun: t.next_run,
        deliveryMode: t.delivery_mode,
        timezone: t.timezone,
      })),
    createTask: (t) =>
      createTask(t.id, t.chatId, t.prompt, t.schedule, t.nextRun, t.name ?? undefined, t.deliveryMode, t.timezone),
    deleteTask,
    newId: () => randomUUID().slice(0, 8),
    nextRun: computeNextRun,
    timeZone: installTimezone,
  }
}
