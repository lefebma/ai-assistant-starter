import { describe, it, expect } from 'vitest'
import { createRun, type Obligation, type Evidence } from '../src/assurance/obligations.js'

const obs: Obligation[] = [
  { id: 'draft-saved', description: 'Draft saved', evidenceType: 'file.written' },
  { id: 'sent', description: 'Email sent', evidenceType: 'email.sent', minCount: 2 },
]
const ev = (over: Partial<Evidence>): Evidence => ({
  eventId: 'e1', runId: 'r1', origin: 'tool', evidenceType: 'file.written', obligationId: 'draft-saved', ...over,
})

describe('obligation checker (card 168)', () => {
  it('versions the obligation set at creation', () => {
    const { model } = createRun('r1', obs)
    expect(model.snapshot().version).toBe(1)
    expect(model.snapshot().obligations).toHaveLength(2)
  })

  it('complete only when every obligation has qualified evidence', () => {
    const { authority, model } = createRun('r1', obs)
    authority.record(ev({}))
    expect(model.requestCompletion().status).toBe('incomplete')
    authority.record(ev({ eventId: 'e2', evidenceType: 'email.sent', obligationId: 'sent' }))
    authority.record(ev({ eventId: 'e3', evidenceType: 'email.sent', obligationId: 'sent' }))
    const v = model.requestCompletion()
    expect(v.status).toBe('complete')
    expect(v.unmet).toEqual([])
  })

  it('rejects model-origin evidence and mismatched evidence types', () => {
    const { authority, model } = createRun('r1', [obs[0]])
    expect(authority.record(ev({ origin: 'model' })).accepted).toBe(false)
    expect(authority.record(ev({ eventId: 'e9', evidenceType: 'email.sent' })).accepted).toBe(false)
    expect(authority.record(ev({ eventId: 'e10', runId: 'other' })).accepted).toBe(false)
    expect(authority.record(ev({ eventId: 'e11', obligationId: 'nope' })).accepted).toBe(false)
    expect(model.requestCompletion().status).toBe('incomplete')
  })

  it('the model facet cannot mutate state or force completion', () => {
    const { model } = createRun('r1', obs)
    const m = model as unknown as Record<string, unknown>
    expect(m.record).toBeUndefined()
    expect(m.fail).toBeUndefined()
    expect(m.amend).toBeUndefined()
    const snap = model.snapshot()
    expect(() => { (snap.obligations as Obligation[]).push(obs[0]) }).toThrow()
    expect(() => { (snap as { version: number }).version = 99 }).toThrow()
    expect(model.requestCompletion().status).toBe('incomplete')
  })

  it('failed, cancelled and unknown can never read as complete, even with all evidence', () => {
    for (const end of ['fail', 'cancel', 'markUnknown'] as const) {
      const { authority, model } = createRun('r1', [obs[0]])
      authority.record(ev({}))
      authority[end]('test')
      const status = model.requestCompletion().status
      expect(status).not.toBe('complete')
      expect(status).toBe(end === 'fail' ? 'failed' : end === 'cancel' ? 'cancelled' : 'unknown')
    }
  })

  it('terminal states are sticky against late evidence', () => {
    const { authority, model } = createRun('r1', [obs[0]])
    authority.fail('tool crashed')
    authority.record(ev({}))
    expect(model.requestCompletion().status).toBe('failed')
  })

  it('duplicate events are ignored and do not double count', () => {
    const { authority, model } = createRun('r1', [obs[1]])
    const e = ev({ eventId: 'dup', evidenceType: 'email.sent', obligationId: 'sent' })
    expect(authority.record(e).accepted).toBe(true)
    const again = authority.record(e)
    expect(again.accepted).toBe(false)
    expect(again.reason).toBe('duplicate')
    expect(model.requestCompletion().status).toBe('incomplete')
    expect(model.requestCompletion().unmet[0]).toMatchObject({ id: 'sent', have: 1, need: 2 })
  })

  it('scope change bumps the version, keeps unchanged satisfied obligations, and reopens completion', () => {
    const { authority, model } = createRun('r1', [obs[0]])
    authority.record(ev({}))
    expect(model.requestCompletion().status).toBe('complete')
    authority.amend([obs[0], { id: 'review', description: 'Reviewed', evidenceType: 'review.ok' }], 'owner added review step')
    expect(model.snapshot().version).toBe(2)
    const v = model.requestCompletion()
    expect(v.status).toBe('incomplete')
    expect(v.unmet.map(u => u.id)).toEqual(['review'])
    authority.record(ev({ eventId: 'e5', evidenceType: 'review.ok', obligationId: 'review' }))
    expect(model.requestCompletion().status).toBe('complete')
  })

  it('a changed obligation spec loses its earlier evidence', () => {
    const { authority, model } = createRun('r1', [obs[0]])
    authority.record(ev({}))
    authority.amend([{ ...obs[0], evidenceType: 'file.published' }], 'stricter')
    expect(model.requestCompletion().status).toBe('incomplete')
  })

  it('an empty obligation set is never complete (nothing was promised)', () => {
    const { model } = createRun('r1', [])
    expect(model.requestCompletion().status).toBe('unknown')
  })
})
