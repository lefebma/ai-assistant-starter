import { describe, it, expect, vi } from 'vitest'
import { rmSync } from 'node:fs'

const { runAgentSpy } = vi.hoisted(() => {
  // Own store dir: this file uses the real db, and sharing the suite-wide
  // dir with schedule-once.test.ts (which wipes it at load) would race.
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-cronlane`
  return { runAgentSpy: vi.fn(async (..._args: unknown[]) => ({ text: 'done' })) }
})

vi.mock('../src/agent.js', () => ({
  runAgent: runAgentSpy,
  isChatLaneActive: () => false,
  markLane: () => {},
  clearLane: () => {},
}))

import { initDatabase, createTask } from '../src/db.js'
import { runDueTasks } from '../src/scheduler.js'

// The db opens lazily on first use, so wiping here (after imports, before
// initDatabase) is safe and keeps reruns from colliding with old rows.
rmSync(process.env.AGENT_STORE_DIR!, { recursive: true, force: true })

describe('scheduler lane routing', () => {
  it('runs scheduled tasks on the cron lane', async () => {
    initDatabase()
    createTask('lane-1', '123', 'do scheduled work', '0 9 * * *', Math.floor(Date.now() / 1000) - 60, 'Lane', 'silent')
    await runDueTasks()
    expect(runAgentSpy).toHaveBeenCalled()
    const args = runAgentSpy.mock.calls[0]
    expect(args[0]).toBe('do scheduled work')
    expect(args[args.length - 1]).toBe('cron')
  })
})
