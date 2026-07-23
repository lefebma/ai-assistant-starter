/**
 * tests/eval-runner.test.ts
 *
 * Phase 4 certification: the runner executes one task (or a lane of tasks)
 * against an AgentRuntime and grades the result. Exercised here against a fake
 * runtime so the harness mechanics — followUp session threading, check
 * pass/fail, the throw path, per-task callbacks, and the per-task temp
 * workspace — are covered with zero API cost.
 */
import { describe, expect, it } from 'vitest'
import { runLane, runTask } from '../src/eval/runner.js'
import type { Task } from '../src/eval/types.js'
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from '../src/runtime/types.js'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake'
  readonly calls: AgentRunOptions[] = []
  constructor(private readonly script: (opts: AgentRunOptions, i: number) => AgentRunResult) {}
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const i = this.calls.length
    this.calls.push(options)
    return this.script(options, i)
  }
  async runOnce(): Promise<string> {
    return ''
  }
  steer(): void {}
  getActiveWorkspaces(): ReadonlyMap<string, string> {
    return new Map()
  }
}

const task = (over: Partial<Task> & Pick<Task, 'name' | 'check'>): Task => ({
  category: 'shell',
  tier: 'smoke',
  message: () => 'go',
  ...over,
})

describe('runTask', () => {
  it('passes when the check returns true', async () => {
    const rt = new FakeRuntime(() => ({ text: '42' }))
    const r = await runTask(rt, task({ name: 'ok', check: t => (t === '42' ? true : 'no') }))
    expect(r).toMatchObject({ task: 'ok', pass: true, detail: 'ok' })
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('fails and carries the check message as detail', async () => {
    const rt = new FakeRuntime(() => ({ text: '7' }))
    const r = await runTask(rt, task({ name: 'bad', check: () => 'expected 42' }))
    expect(r.pass).toBe(false)
    expect(r.detail).toBe('expected 42')
  })

  it('threads the first turn newSessionId into a followUp turn', async () => {
    const rt = new FakeRuntime((_opts, i) =>
      i === 0 ? { text: 'noted', newSessionId: 's-1' } : { text: 'osprey-9' },
    )
    const r = await runTask(
      rt,
      task({
        name: 'memory',
        followUp: () => 'what was the code?',
        check: t => (t === 'osprey-9' ? true : `got ${t}`),
      }),
    )
    expect(r.pass).toBe(true)
    expect(rt.calls[1].sessionId).toBe('s-1')
  })

  it('marks a thrown runtime error as a failure with a threw: detail', async () => {
    const rt = new FakeRuntime(() => {
      throw new Error('boom')
    })
    const r = await runTask(rt, task({ name: 'explode', check: () => true }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/^threw: boom/)
  })

  it('gives each task an isolated temp workspace via ctx.dir', async () => {
    const rt = new FakeRuntime(() => ({ text: 'done' }))
    const r = await runTask(
      rt,
      task({
        name: 'workspace',
        message: ctx => {
          writeFileSync(join(ctx.dir, 'seed.txt'), 'here')
          return 'edit it'
        },
        check: (_t, ctx) => (readFileSync(join(ctx.dir, 'seed.txt'), 'utf-8') === 'here' ? true : 'gone'),
      }),
    )
    expect(r.pass).toBe(true)
  })
})

describe('runLane', () => {
  it('runs every task, names the lane, and fires onResult per task', async () => {
    const rt = new FakeRuntime(() => ({ text: 'x' }))
    const seen: string[] = []
    const lane = await runLane(
      'anthropic',
      rt,
      [task({ name: 'a', check: () => true }), task({ name: 'b', check: () => 'fail' })],
      r => seen.push(r.task),
    )
    expect(lane.name).toBe('anthropic')
    expect(lane.results.map(r => r.task)).toEqual(['a', 'b'])
    expect(lane.results.map(r => r.pass)).toEqual([true, false])
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('runTask cleanup and error handling', () => {
  it('removes the per-task temp workspace after the task completes', async () => {
    const rt = new FakeRuntime(() => ({ text: 'done' }))
    let capturedDir = ''
    await runTask(
      rt,
      task({
        name: 'cleanup',
        message: ctx => {
          capturedDir = ctx.dir
          return 'go'
        },
        check: () => true,
      }),
    )
    expect(capturedDir).not.toBe('')
    expect(existsSync(capturedDir)).toBe(false)
  })

  it('marks a thrown check() error as a failure too, not just a thrown runtime.run()', async () => {
    const rt = new FakeRuntime(() => ({ text: 'x' }))
    const r = await runTask(
      rt,
      task({
        name: 'check-throws',
        check: () => {
          throw new Error('bad check')
        },
      }),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/^threw: bad check/)
  })
})
