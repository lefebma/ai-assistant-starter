/**
 * Card #234: obligation state on disk. openRun is createRun with every change
 * saved, so reopening the same run id after a restart sees what the first
 * boot proved.
 */
import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'

process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-runstate-${process.pid}`
rmSync(process.env.AGENT_STORE_DIR, { recursive: true, force: true })

const { initDatabase } = await import('../src/db.js')
const { createRun } = await import('../src/assurance/obligations.js')
const { loadRunState, markRunUnknown, openRun } = await import('../src/assurance/run-state.js')

initDatabase()

const OBLIGATIONS = [
  { id: 'status', description: 'CRM status updated', evidenceType: 'crm.update' },
  { id: 'email', description: 'Reminder sent', evidenceType: 'email.sent' },
]
const ev = (runId: string, eventId: string, obligationId: string, evidenceType: string, origin: 'app' | 'tool' | 'model' = 'tool') =>
  ({ eventId, runId, origin, evidenceType, obligationId })

describe('openRun', () => {
  it('a reopened run keeps the evidence the first boot recorded', () => {
    const first = openRun('job:r1', OBLIGATIONS)
    expect(first.restored).toBe(false)
    expect(first.authority.record(ev('job:r1', 'e1', 'status', 'crm.update')).accepted).toBe(true)

    // Restart: a new handle, same run id.
    const second = openRun('job:r1', OBLIGATIONS)
    expect(second.restored).toBe(true)
    expect(second.authority.requestCompletion()).toMatchObject({ status: 'incomplete', unmet: [{ id: 'email', have: 0, need: 1 }] })
    // The first boot's event is still a duplicate, not new evidence.
    expect(second.authority.record(ev('job:r1', 'e1', 'status', 'crm.update'))).toEqual({ accepted: false, reason: 'duplicate' })
    expect(second.authority.record(ev('job:r1', 'e2', 'email', 'email.sent')).accepted).toBe(true)
    expect(openRun('job:r1', OBLIGATIONS).authority.requestCompletion().status).toBe('complete')
  })

  it('an in-memory run, the way it was before, forgets on restart', () => {
    const a = createRun('job:mem', OBLIGATIONS).authority
    a.record(ev('job:mem', 'e1', 'status', 'crm.update'))
    a.record(ev('job:mem', 'e2', 'email', 'email.sent'))
    expect(a.requestCompletion().status).toBe('complete')
    expect(createRun('job:mem', OBLIGATIONS).authority.requestCompletion().status).toBe('incomplete')
  })

  it('a saved run keeps its own obligations and version; amend changes them and is saved', () => {
    const { authority } = openRun('job:r2', OBLIGATIONS)
    authority.record(ev('job:r2', 'e1', 'status', 'crm.update'))
    authority.amend([OBLIGATIONS[0]], 'email dropped by the owner')
    const again = openRun('job:r2', [{ id: 'other', description: 'ignored', evidenceType: 'x' }])
    expect(again.model.snapshot().version).toBe(2)
    expect(again.model.snapshot().obligations.map(o => o.id)).toEqual(['status'])
    expect(again.model.requestCompletion().status).toBe('complete')
  })

  it('model-origin evidence is refused and nothing about it is saved', () => {
    const { authority } = openRun('job:r3', OBLIGATIONS)
    expect(authority.record(ev('job:r3', 'm1', 'email', 'email.sent', 'model')).reason).toBe('unqualified-origin')
    expect(loadRunState('job:r3')!.seen).toEqual([])
  })

  it('a duplicate past maxCount survives the restart and keeps the run from reading complete', () => {
    const { authority } = openRun('job:r4', OBLIGATIONS)
    authority.record(ev('job:r4', 'e1', 'status', 'crm.update'))
    authority.record(ev('job:r4', 'e2', 'email', 'email.sent'))
    expect(authority.record(ev('job:r4', 'e3', 'email', 'email.sent')).reason).toBe('over-limit')
    expect(openRun('job:r4', OBLIGATIONS).authority.requestCompletion().status).toBe('unknown')
  })

  it('a terminal status is saved: a closed run refuses evidence after the restart', () => {
    openRun('job:r5', OBLIGATIONS).authority.fail('the destination refused')
    const again = openRun('job:r5', OBLIGATIONS)
    expect(again.authority.requestCompletion()).toMatchObject({ status: 'failed', reason: 'the destination refused' })
    expect(again.authority.record(ev('job:r5', 'e1', 'status', 'crm.update')).reason).toBe('run-closed')
  })
})

describe('markRunUnknown', () => {
  it('closes a saved run as unknown, keeps its evidence, and does not reopen a closed one', () => {
    openRun('job:u1', OBLIGATIONS).authority.record(ev('job:u1', 'e1', 'status', 'crm.update'))
    expect(markRunUnknown('job:u1', 'cut off by a crash')).toBe('unknown')
    const s = loadRunState('job:u1')!
    expect(s.terminal).toEqual({ status: 'unknown', reason: 'cut off by a crash' })
    expect(s.satisfied.status).toEqual(['e1'])
    expect(markRunUnknown('job:u1', 'again')).toBe('unknown')
    expect(loadRunState('job:u1')!.terminal!.reason).toBe('cut off by a crash')
  })

  it('a run that was never opened is left alone', () => {
    expect(markRunUnknown('job:never', 'x')).toBeNull()
    expect(loadRunState('job:never')).toBeUndefined()
  })
})
