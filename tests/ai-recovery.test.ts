/**
 * Card #158 final review: the recovery timer is the only background recovery
 * probe. One tiny call through the managed runtime when recovery is due;
 * nothing at all on a non-managed box or while no probe is due.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiPausedError, MANAGED_AI_FILE, clearAiLimit, readAiLimit, writeAiLimit } from '../src/ai-limit.js'
import { recoveryProbeTick, startAiRecovery, RECOVERY_PROBE_PROMPT } from '../src/ai-recovery.js'

const MIN = 60_000
function store(managed = true): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-recovery-'))
  if (managed) writeFileSync(join(d, MANAGED_AI_FILE), '{}')
  return d
}
const old = (): string => new Date(Date.now() - 20 * MIN).toISOString()

describe('recoveryProbeTick', () => {
  it('does nothing without a marker', async () => {
    const runOnce = vi.fn(async () => 'ready')
    expect(await recoveryProbeTick({ storeDir: store(), runOnce })).toBe('none')
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('does nothing on a non-managed box, even with a due marker', async () => {
    const d = store(false)
    writeAiLimit({ kind: 'spend_limit', since: old() }, d)
    const runOnce = vi.fn(async () => 'ready')
    expect(await recoveryProbeTick({ storeDir: d, runOnce })).toBe('none')
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('does nothing while recovery is not yet due', async () => {
    const d = store()
    writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString() }, d)
    const runOnce = vi.fn(async () => 'ready')
    expect(await recoveryProbeTick({ storeDir: d, runOnce })).toBe('none')
    expect(runOnce).not.toHaveBeenCalled()
  })

  it('makes one tiny haiku call when due; cleared when the runtime clears the marker', async () => {
    const d = store()
    writeAiLimit({ kind: 'spend_limit', since: old() }, d)
    const runOnce = vi.fn(async () => {
      clearAiLimit(d)
      return 'ready'
    })
    expect(await recoveryProbeTick({ storeDir: d, runOnce })).toBe('cleared')
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(runOnce).toHaveBeenCalledWith(RECOVERY_PROBE_PROMPT, { model: 'haiku' })
    expect(RECOVERY_PROBE_PROMPT).toBe('Reply with exactly one word: ready')
  })

  it('reports still-paused on AiPausedError, quietly', async () => {
    const d = store()
    writeAiLimit({ kind: 'billing', since: old() }, d)
    const runOnce = vi.fn(async () => {
      throw new AiPausedError('billing')
    })
    expect(await recoveryProbeTick({ storeDir: d, runOnce })).toBe('still-paused')
    expect(readAiLimit(d)?.kind).toBe('billing')
  })

  it('reports error on any other failure, quietly', async () => {
    const d = store()
    writeAiLimit({ kind: 'spend_limit', since: old() }, d)
    const runOnce = vi.fn(async () => {
      throw new Error('API Error: 500 overloaded')
    })
    expect(await recoveryProbeTick({ storeDir: d, runOnce })).toBe('error')
  })
})

describe('startAiRecovery', () => {
  it('is not started on a non-managed box', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const stop = startAiRecovery({ storeDir: store(false), runOnce: vi.fn() })
    expect(setIntervalSpy).not.toHaveBeenCalled()
    stop()
    setIntervalSpy.mockRestore()
  })

  it('on a managed box ticks every 60 s', async () => {
    vi.useFakeTimers()
    try {
      const d = store()
      writeAiLimit({ kind: 'spend_limit', since: new Date(Date.now() - 20 * MIN).toISOString() }, d)
      const runOnce = vi.fn(async () => {
        clearAiLimit(d)
        return 'ready'
      })
      const stop = startAiRecovery({ storeDir: d, runOnce })
      expect(runOnce).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runOnce).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runOnce).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
