import { describe, it, expect } from 'vitest'
import { signState, verifyState, MemoryUsedStore, STATE_TTL_MS } from '../src/connect/state.js'

const SECRET = 'relay-signing-secret-for-tests-0123456789'
const base = { box: 'box-1', provider: 'gmail', nonce: 'n-abc' }

describe('connect state', () => {
  it('round-trips and names the box', async () => {
    const t = 1_000_000
    const s = signState(SECRET, base, t)
    const r = await verifyState(SECRET, s, new MemoryUsedStore(), t + 1000)
    expect(r).toMatchObject({ ok: true, payload: { box: 'box-1', provider: 'gmail', nonce: 'n-abc' } })
  })
  it('refuses an expired state (10 minutes)', async () => {
    const t = 1_000_000
    const s = signState(SECRET, base, t)
    expect(STATE_TTL_MS).toBe(10 * 60_000)
    const r = await verifyState(SECRET, s, new MemoryUsedStore(), t + STATE_TTL_MS + 1)
    expect(r).toEqual({ ok: false, reason: 'expired' })
  })
  it('refuses a replayed state', async () => {
    const t = 1_000_000
    const used = new MemoryUsedStore()
    const s = signState(SECRET, base, t)
    expect((await verifyState(SECRET, s, used, t)).ok).toBe(true)
    expect(await verifyState(SECRET, s, used, t + 5)).toEqual({ ok: false, reason: 'replayed' })
  })
  it('refuses a tampered payload or wrong key', async () => {
    const t = 1_000_000
    const s = signState(SECRET, base, t)
    const [p, sig] = s.split('.')
    const forged = Buffer.from(JSON.stringify({ ...base, box: 'box-evil', exp: t + 1000 })).toString('base64url')
    expect(await verifyState(SECRET, `${forged}.${sig}`, new MemoryUsedStore(), t)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verifyState('other-secret-other-secret-other-secret', s, new MemoryUsedStore(), t)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verifyState(SECRET, 'garbage', new MemoryUsedStore(), t)).toEqual({ ok: false, reason: 'malformed' })
    void p
  })
  it('rejects a short signing secret', () => {
    expect(() => signState('short', base, 1)).toThrow()
  })
})
