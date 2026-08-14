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

describe('structural self-test (fresh-install safe)', () => {
  it('passes in an unconfigured, isolated environment', async () => {
    // vitest env isolates AGENT_STORE_DIR and the vault; no bot token is set.
    // A freshly built bundle has no account attached and must still verify
    // structurally, which is what CI runs.
    expect(await runSelfTest({ quiet: true, skipAuth: true })).toBe(true)
  })

  it('covers the load-bearing subsystems', () => {
    const names = defaultChecks({ skipAuth: true }).map((c) => c.name)
    for (const expected of ['node-version', 'config', 'database', 'vault', 'runtime']) {
      expect(names).toContain(expected)
    }
  })
})

describe('credentials check', () => {
  const green = async () => ({ ok: true, detail: 'signed in' })

  it('is on by default and off under --skip-auth', () => {
    expect(defaultChecks({ credentials: green }).map((c) => c.name)).toContain('credentials')
    expect(defaultChecks({ skipAuth: true }).map((c) => c.name)).not.toContain('credentials')
  })

  it('fails the whole run when the install cannot reach a model', async () => {
    // The regression this exists for: an install with no account behind it
    // used to report PASS, then fail to answer its owner's first message.
    const ok = await runSelfTest({
      quiet: true,
      credentials: async () => ({ ok: false, detail: 'no sign-in and no API key', remedy: 'Sign in, or set a key.' }),
    })
    expect(ok).toBe(false)
  })

  it('puts the remedy in the failure line, not just the diagnosis', async () => {
    const check = defaultChecks({
      credentials: async () => ({ ok: false, detail: 'no sign-in', remedy: 'Sign in with Claude Pro or Max.' }),
    }).find((c) => c.name === 'credentials')!
    const { results } = await runChecks([check])
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('no sign-in')
    expect(results[0].detail).toContain('Claude Pro or Max')
  })

  it('only makes a real model call when asked', () => {
    expect(defaultChecks({ credentials: green }).map((c) => c.name)).not.toContain('live-model-call')
    expect(defaultChecks({ credentials: green, live: true }).map((c) => c.name)).toContain('live-model-call')
  })
})
