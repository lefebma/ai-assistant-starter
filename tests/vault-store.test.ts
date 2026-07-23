/**
 * tests/vault-store.test.ts
 *
 * BYOK vault (Phase 4 slice a): the encrypted secret store. Secrets live in an
 * AES-256-GCM blob on disk; the 32-byte key is a separate 0600 file. This
 * verifies the round-trip through disk, names-only listing, deletion, and the
 * two properties that make it a vault rather than a plaintext .env: the on-disk
 * blob contains no plaintext, and the key file is created 0600. Everything runs
 * against a throwaway tmp dir.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretVault } from '../src/vault/store.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SecretVault', () => {
  it('round-trips a secret through set/get', () => {
    const v = new SecretVault({ dir })
    v.set('OPENAI_API_KEY', 'sk-abc-123')
    expect(v.get('OPENAI_API_KEY')).toBe('sk-abc-123')
  })

  it('returns undefined for an unknown name', () => {
    expect(new SecretVault({ dir }).get('NOPE')).toBeUndefined()
  })

  it('lists names only, sorted, never values', () => {
    const v = new SecretVault({ dir })
    v.set('B_KEY', 'secretB')
    v.set('A_KEY', 'secretA')
    expect(v.list()).toEqual(['A_KEY', 'B_KEY'])
    expect(JSON.stringify(v.list())).not.toContain('secret')
  })

  it('reports presence via has()', () => {
    const v = new SecretVault({ dir })
    v.set('K', 'v')
    expect(v.has('K')).toBe(true)
    expect(v.has('MISSING')).toBe(false)
  })

  it('deletes a secret and reports whether it existed', () => {
    const v = new SecretVault({ dir })
    v.set('K', 'v')
    expect(v.delete('K')).toBe(true)
    expect(v.get('K')).toBeUndefined()
    expect(v.delete('K')).toBe(false)
  })

  it('overwrites an existing name', () => {
    const v = new SecretVault({ dir })
    v.set('K', 'old')
    v.set('K', 'new')
    expect(v.get('K')).toBe('new')
  })

  it('persists across instances (encrypted disk round-trip)', () => {
    new SecretVault({ dir }).set('TELEGRAM_BOT_TOKEN', '123:abc')
    // fresh instance, same dir — must decrypt what the first one wrote
    expect(new SecretVault({ dir }).get('TELEGRAM_BOT_TOKEN')).toBe('123:abc')
  })

  it('stores no plaintext on disk (encrypted at rest)', () => {
    const v = new SecretVault({ dir })
    v.set('SECRET', 'plaintext-should-not-appear')
    const files = ['secrets.json', 'vault.key']
    for (const f of files) {
      if (existsSync(join(dir, f))) {
        expect(readFileSync(join(dir, f), 'utf-8')).not.toContain('plaintext-should-not-appear')
      }
    }
  })

  it('creates the key file with 0600 permissions', () => {
    const v = new SecretVault({ dir })
    v.set('K', 'v')
    const mode = statSync(join(dir, 'vault.key')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates the secrets blob with 0600 permissions too (not just the key)', () => {
    const v = new SecretVault({ dir })
    v.set('K', 'v')
    const mode = statSync(join(dir, 'secrets.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates a new vault directory with 0700 permissions (not listable by other local users)', () => {
    // Force the vault to create its own dir (the beforeEach tmp dir already
    // exists at 0700 from mkdtemp, which would mask the behavior under test).
    const nested = join(dir, 'created-by-vault')
    const v = new SecretVault({ dir: nested })
    v.set('K', 'v')
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })
})
