/**
 * Task runner for the certification harness (Phase 4).
 *
 * Executes a single golden task (or a lane of them) against any AgentRuntime
 * and grades the output. Each task gets an isolated temp workspace (ctx.dir);
 * two-turn tasks thread the first turn's session id into the followUp so
 * memory/resume is actually exercised. No printing here — runLane fires an
 * optional onResult callback so the CLI owns presentation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntime } from '../runtime/types.js'
import type { LaneResult, Task, TaskContext, TaskResult } from './types.js'

export async function runTask(runtime: AgentRuntime, task: Task): Promise<TaskResult> {
  const ctx: TaskContext = { dir: mkdtempSync(join(tmpdir(), `ab-eval-${task.name}-`)) }
  const start = Date.now()
  try {
    const first = await runtime.run({ message: task.message(ctx) })
    let finalText = first.text ?? ''
    if (task.followUp) {
      const second = await runtime.run({ message: task.followUp(ctx), sessionId: first.newSessionId })
      finalText = second.text ?? ''
    }
    const verdict = task.check(finalText, ctx)
    return {
      task: task.name,
      pass: verdict === true,
      detail: verdict === true ? 'ok' : verdict,
      ms: Date.now() - start,
    }
  } catch (err) {
    return {
      task: task.name,
      pass: false,
      detail: `threw: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
      ms: Date.now() - start,
    }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
}

export async function runLane(
  name: string,
  runtime: AgentRuntime,
  tasks: Task[],
  onResult?: (r: TaskResult) => void,
): Promise<LaneResult> {
  const results: TaskResult[] = []
  for (const task of tasks) {
    const r = await runTask(runtime, task)
    results.push(r)
    onResult?.(r)
  }
  return { name, results }
}
