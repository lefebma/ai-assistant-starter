/**
 * tests/vault-resolve.test.ts
 *
 * BYOK vault (Phase 4 slice a): getSecret() is the additive, non-breaking
 * resolver. It prefers a secret stored in the vault, then falls back to .env,
 * then process.env — so nothing breaks for an install that hasn't migrated any
 * secrets yet, and a migrated secret quietly takes precedence. .env is read via
 * the mocked seam so the real .env never leaks into assertions.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
}))
vi.mock('../src/env.js', () => ({ readEnvFile: mockReadEnvFile }))

import { getSecret } from '../src/vault/index.js'
import { SecretVault } from '../src/vault/store.js'

const NAME = 'VAULT_RES_TEST'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-res-'))
  mockReadEnvFile.mockReturnValue({})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env[NAME]
})

describe('getSecret', () => {
  it('prefers the vault over .env and process.env', () => {
    const v = new SecretVault({ dir })
    v.set(NAME, 'from-vault')
    mockReadEnvFile.mockReturnValue({ [NAME]: 'from-env' })
    process.env[NAME] = 'from-process'
    expect(getSecret(NAME, v)).toBe('from-vault')
  })

  it('falls back to .env when the vault lacks it', () => {
    mockReadEnvFile.mockReturnValue({ [NAME]: 'from-env' })
    expect(getSecret(NAME, new SecretVault({ dir }))).toBe('from-env')
  })

  it('prefers .env over process.env (matches existing codebase precedence)', () => {
    mockReadEnvFile.mockReturnValue({ [NAME]: 'from-env' })
    process.env[NAME] = 'from-process'
    expect(getSecret(NAME, new SecretVault({ dir }))).toBe('from-env')
  })

  it('falls back to process.env when neither vault nor .env has it', () => {
    process.env[NAME] = 'from-process'
    expect(getSecret(NAME, new SecretVault({ dir }))).toBe('from-process')
  })

  it('returns undefined when the secret exists nowhere', () => {
    expect(getSecret('NOWHERE_AT_ALL', new SecretVault({ dir }))).toBeUndefined()
  })

  it('trims surrounding whitespace on the resolved value', () => {
    const v = new SecretVault({ dir })
    v.set(NAME, '  sk-padded  ')
    expect(getSecret(NAME, v)).toBe('sk-padded')
  })

  it('treats a whitespace-only value as unset and falls through to the next source', () => {
    const v = new SecretVault({ dir })
    v.set(NAME, '   ') // effectively empty
    mockReadEnvFile.mockReturnValue({ [NAME]: 'from-env' })
    expect(getSecret(NAME, v)).toBe('from-env')
  })

  it('uses the default vault (honoring AGENT_VAULT_DIR) when none is injected', () => {
    new SecretVault({ dir }).set(NAME, 'from-default-vault')
    const prev = process.env.AGENT_VAULT_DIR
    process.env.AGENT_VAULT_DIR = dir
    try {
      expect(getSecret(NAME)).toBe('from-default-vault')
    } finally {
      if (prev === undefined) delete process.env.AGENT_VAULT_DIR
      else process.env.AGENT_VAULT_DIR = prev
    }
  })
})

describe('config.ts <-> vault/store.ts import cycle (regression)', () => {
  it('imports config.ts and resolves a secret through getSecret without an eval-time cycle throw', async () => {
    // Regression guard for the config <-> vault import cycle: config.ts calls
    // getSecret() at module-eval time, and getSecret() (via vault/store.ts)
    // must resolve PROJECT_ROOT from env.ts, never from config.ts, or this
    // throws "SecretVault is not a constructor" the moment config.ts is loaded.
    mockReadEnvFile.mockReturnValue({ TELEGRAM_BOT_TOKEN: 'from-env-token' })
    const config = await import('../src/config.js')
    expect(config.TELEGRAM_BOT_TOKEN).toBe('from-env-token')
    expect(typeof config.PROJECT_ROOT).toBe('string')
    expect(config.PROJECT_ROOT.length).toBeGreaterThan(0)
  })
})
