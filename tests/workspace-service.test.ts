import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { applySyncOutcome, initWorkspaceService, stopWorkspaceService } from '../src/workspace/service.js'
import { saveRegistry } from '../src/workspace/registry.js'
import type { WorkspaceEntry } from '../src/workspace/types.js'

const base: WorkspaceEntry = {
  name: 'havn', repo: 'x', path: '', syncMinutes: 30, enabled: true, chatIds: [], failures: 0,
}
const ok = { ok: true, message: 'up to date', unstaged: [], committed: false, pushed: false }
const bad = { ok: false, message: 'git push failed', unstaged: [], committed: false, pushed: false }

describe('applySyncOutcome', () => {
  it('records a good sync and stays quiet', () => {
    const { entry, notice } = applySyncOutcome(base, ok, 1000)
    expect(entry).toMatchObject({ failures: 0, lastSyncOk: true, lastSyncAt: 1000 })
    expect(notice).toBeNull()
  })

  it('notifies on the third consecutive failure only', () => {
    let e = base
    let n: string | null
    ;({ entry: e, notice: n } = applySyncOutcome(e, bad, 1)); expect(n).toBeNull()
    ;({ entry: e, notice: n } = applySyncOutcome(e, bad, 2)); expect(n).toBeNull()
    ;({ entry: e, notice: n } = applySyncOutcome(e, bad, 3)); expect(n).toMatch(/havn.*3 times/)
    ;({ entry: e, notice: n } = applySyncOutcome(e, bad, 4)); expect(n).toBeNull()
    expect(e.failures).toBe(4)
  })

  it('notifies on recovery after a run of failures', () => {
    const failed = { ...base, failures: 5, lastSyncOk: false }
    const { entry, notice } = applySyncOutcome(failed, ok, 9)
    expect(entry.failures).toBe(0)
    expect(notice).toMatch(/havn.*recovered/)
  })

  it('always notifies a conflict with the file name', () => {
    const r = { ...bad, message: 'rebase conflict', conflict: 'projects/gtm/STATE.md' }
    const { notice } = applySyncOutcome(base, r, 1)
    expect(notice).toContain('projects/gtm/STATE.md')
  })

  it('reports held-back files once, on the run that held them', () => {
    const r = { ...ok, unstaged: [{ path: 'a.md', reason: 'matches a private pattern' }] }
    const { notice } = applySyncOutcome(base, r, 1)
    expect(notice).toContain('a.md')
    expect(notice).toContain('private pattern')
  })
})

describe('initWorkspaceService', () => {
  afterEach(() => {
    stopWorkspaceService()
    vi.useRealTimers()
  })

  it('first timer run re-reads enabled state and skips if disabled', async () => {
    vi.useFakeTimers()
    const storeDir = mkdtempSync('/tmp/test-workspace-')
    const syncOne = vi.fn()

    const entry: WorkspaceEntry = {
      name: 'test-workspace',
      repo: 'git@github.com:test/repo.git',
      path: '',
      syncMinutes: 30,
      enabled: true,
      chatIds: [],
      failures: 0,
    }
    saveRegistry([entry], storeDir)

    initWorkspaceService({ syncOne, notify: async () => {}, storeDir })

    const disabledEntry = { ...entry, enabled: false }
    saveRegistry([disabledEntry], storeDir)

    vi.advanceTimersByTime(20_000)

    expect(syncOne).not.toHaveBeenCalled()
  })
})
