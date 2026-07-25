import { describe, it, expect, vi } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('../src/agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'all done' })),
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))

// Wipe the isolated store before the db singleton opens it, so reruns of the
// suite never collide with rows from a previous run.
rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })

import { initDatabase, createTask, getAllTasks } from '../src/db.js'
import { runDueTasks } from '../src/scheduler.js'

const now = () => Math.floor(Date.now() / 1000)

describe('one-shot scheduled tasks (--once)', () => {
  it('createTask persists run_once, defaulting to 0', () => {
    initDatabase()
    createTask('once-a', '123', 'one shot', '0 9 * * *', now() + 3600, 'OnceA', 'silent', 'America/Toronto', true)
    createTask('recur-a', '123', 'recurring', '0 9 * * *', now() + 3600, 'RecurA', 'silent', 'America/Toronto')
    const tasks = getAllTasks()
    expect(tasks.find((t) => t.id === 'once-a')?.run_once).toBe(1)
    expect(tasks.find((t) => t.id === 'recur-a')?.run_once).toBe(0)
  })

  it('one-shot task self-deletes after a completed run; recurring task stays', async () => {
    initDatabase()
    createTask('once-b', '123', 'one shot', '0 9 * * *', now() - 60, 'OnceB', 'silent', 'America/Toronto', true)
    createTask('recur-b', '123', 'recurring', '0 9 * * *', now() - 60, 'RecurB', 'silent', 'America/Toronto')
    await runDueTasks()
    const ids = getAllTasks().map((t) => t.id)
    expect(ids).not.toContain('once-b')
    expect(ids).toContain('recur-b')
  })
})
