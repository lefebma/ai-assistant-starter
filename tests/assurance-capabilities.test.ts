import { describe, it, expect, vi } from 'vitest'
import { CapabilityBroker, type RoleDef } from '../src/assurance/capabilities.js'

const roles: RoleDef[] = [
  {
    id: 'inbox-triage', summary: 'Read, label and draft email',
    tools: {
      'email.search': { params: { query: { type: 'string', maxLength: 200 }, limit: { type: 'number', max: 50 } } },
      'email.label': { params: { id: { type: 'string' }, label: { type: 'string', oneOf: ['Follow-up', 'Archive'] } } },
    },
  },
  { id: 'finance', summary: 'Move money', tools: { 'payments.send': { params: { amount: { type: 'number', max: 100 }, to: { type: 'string' } } } } },
]
const mk = () => {
  const b = new CapabilityBroker(roles)
  b.startRun('r1', { authorizedRoles: ['inbox-triage'] })
  return b
}
const ok = async () => 'done'

describe('role-scoped capability delivery (card 171)', () => {
  it('a new run sees a minimal role catalog and zero tools', () => {
    const b = mk()
    expect(b.catalog('r1')).toEqual([{ id: 'inbox-triage', summary: 'Read, label and draft email' }])
    expect(b.deliveredTools('r1')).toEqual([])
  })

  it('catalog only lists roles the run is authorized for', () => {
    expect(mk().catalog('r1').map(r => r.id)).not.toContain('finance')
  })

  it('tools arrive only after an authorized role is selected', () => {
    const b = mk()
    expect(b.selectRole('r1', 'finance').ok).toBe(false)
    expect(b.deliveredTools('r1')).toEqual([])
    const sel = b.selectRole('r1', 'inbox-triage')
    expect(sel.ok).toBe(true)
    expect(b.deliveredTools('r1').map(t => t.name).sort()).toEqual(['email.label', 'email.search'])
    expect(b.deliveredTools('r1')[0].params).toBeDefined()
  })

  it('refuses every call before a role is selected, executor never runs', async () => {
    const b = mk(); const exec = vi.fn(ok)
    const r = await b.invoke('r1', 'email.search', { query: 'x' }, exec)
    expect(r).toMatchObject({ ok: false, kind: 'no-role' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('unauthorized tools cannot execute, and cross-role attempts are logged', async () => {
    const b = mk(); b.selectRole('r1', 'inbox-triage'); const exec = vi.fn(ok)
    const r = await b.invoke('r1', 'payments.send', { amount: 5, to: 'a' }, exec)
    expect(r).toMatchObject({ ok: false, kind: 'unauthorized' })
    expect(exec).not.toHaveBeenCalled()
    expect(b.crossRoleLog('r1')).toEqual([expect.objectContaining({ tool: 'payments.send', requiredRole: 'finance', currentRole: 'inbox-triage' })])
  })

  it('out-of-limit and undeclared parameters cannot execute', async () => {
    const b = mk(); b.selectRole('r1', 'inbox-triage'); const exec = vi.fn(ok)
    for (const params of [
      { query: 'x', limit: 51 },
      { query: 'y'.repeat(201) },
      { query: 'x', limit: 'ten' },
      { query: 'x', bcc: 'evil@example.com' },
    ]) expect(await b.invoke('r1', 'email.search', params, exec)).toMatchObject({ ok: false, kind: 'param-limit' })
    expect(await b.invoke('r1', 'email.label', { id: '1', label: 'Delete' }, exec)).toMatchObject({ ok: false, kind: 'param-limit' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('in-limit calls execute', async () => {
    const b = mk(); b.selectRole('r1', 'inbox-triage'); const exec = vi.fn(ok)
    expect(await b.invoke('r1', 'email.search', { query: 'invoice', limit: 50 }, exec)).toMatchObject({ ok: true, result: 'done' })
    expect(exec).toHaveBeenCalledOnce()
  })

  it('role switching needs a governed transition, approved by the harness', async () => {
    const b = new CapabilityBroker(roles)
    b.startRun('r1', { authorizedRoles: ['inbox-triage', 'finance'] })
    b.selectRole('r1', 'inbox-triage')
    const req = b.requestTransition('r1', 'finance', 'user asked to pay invoice')
    expect(req.status).toBe('pending')
    expect(await b.invoke('r1', 'payments.send', { amount: 1, to: 'a' }, ok)).toMatchObject({ ok: false })
    expect(b.selectRole('r1', 'finance').ok).toBe(false) // direct switch refused mid-run
    b.approveTransition('r1', req.id, 'owner')
    expect(b.currentRole('r1')).toBe('finance')
    expect(await b.invoke('r1', 'payments.send', { amount: 1, to: 'a' }, ok)).toMatchObject({ ok: true })
    // previous role's tools are gone
    expect(await b.invoke('r1', 'email.search', { query: 'x' }, ok)).toMatchObject({ ok: false, kind: 'unauthorized' })
  })

  it('a transition to an unauthorized role cannot be approved', () => {
    const b = mk(); b.selectRole('r1', 'inbox-triage')
    const req = b.requestTransition('r1', 'finance', 'sneaky')
    expect(b.approveTransition('r1', req.id, 'owner')).toBe(false)
    expect(b.currentRole('r1')).toBe('inbox-triage')
  })

  it('measures discovery failures separately from authorization failures', async () => {
    const b = mk(); b.selectRole('r1', 'inbox-triage')
    await b.invoke('r1', 'email.search', { query: 'a' }, ok) // success
    await b.invoke('r1', 'email.serch', { query: 'a' }, ok) // discovery: no such tool
    await b.invoke('r1', 'payments.send', { amount: 1, to: 'a' }, ok) // authorization
    await b.invoke('r1', 'email.search', { limit: 999 }, ok) // parameter
    expect(b.metrics('r1')).toEqual({
      calls: 4, success: 1, discoveryFailures: 1, authorizationFailures: 1, parameterFailures: 1, noRoleFailures: 0,
      crossRoleRequests: 1, selectionSuccessRate: 0.75,
    })
  })

  it('runs are isolated', () => {
    const b = mk(); b.startRun('r2', { authorizedRoles: [] })
    b.selectRole('r1', 'inbox-triage')
    expect(b.deliveredTools('r2')).toEqual([])
    expect(b.catalog('r2')).toEqual([])
  })
})
