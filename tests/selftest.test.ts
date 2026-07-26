import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => {
  // Own store dir: the db check opens the real database module, and the
  // suite-wide shared dir gets wiped by other test files at their load time.
  process.env.AGENT_STORE_DIR = `${process.env.AGENT_STORE_DIR ?? '/tmp'}-selftest`
})

import { runChecks, defaultChecks, runSelfTest } from '../src/selftest.js'

describe('runChecks', () => {
  it('aggregates passing checks with their details', async () => {
    const { ok, results } = await runChecks([
      { name: 'a', run: () => 'fine' },
      { name: 'b', run: async () => 'also fine' },
    ])
    expect(ok).toBe(true)
    expect(results).toEqual([
      { name: 'a', ok: true, detail: 'fine' },
      { name: 'b', ok: true, detail: 'also fine' },
    ])
  })

  it('a throwing check fails the run but the rest still execute', async () => {
    const { ok, results } = await runChecks([
      { name: 'boom', run: () => { throw new Error('db locked') } },
      { name: 'after', run: () => 'ran anyway' },
    ])
    expect(ok).toBe(false)
    expect(results[0]).toMatchObject({ name: 'boom', ok: false })
    expect(results[0].detail).toContain('db locked')
    expect(results[1].ok).toBe(true)
  })
})

describe('offline self-test (fresh-install safe)', () => {
  it('passes in an unconfigured, isolated environment', async () => {
    // vitest env isolates AGENT_STORE_DIR and the vault; no bot token is set.
    // A fresh install must self-test green before credentials exist.
    expect(await runSelfTest({ quiet: true })).toBe(true)
  })

  it('covers the load-bearing subsystems', () => {
    const names = defaultChecks().map((c) => c.name)
    for (const expected of ['node-version', 'config', 'database', 'vault', 'runtime']) {
      expect(names).toContain(expected)
    }
  })
})
