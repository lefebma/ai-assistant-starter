import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { FileKeyBackend, KeyringKeyBackend, resolveKeyBackend } from '../src/vault/key-backend.js'
import type { KeyBackend } from '../src/vault/key-backend.js'
import { SecretVault } from '../src/vault/store.js'

const dir = () => mkdtempSync(join(tmpdir(), 'vault-kb-'))

describe('FileKeyBackend', () => {
  it('returns null when no key exists yet', () => {
    expect(new FileKeyBackend(dir()).getKey()).toBeNull()
  })

  it('roundtrips a 32-byte key', () => {
    const b = new FileKeyBackend(dir())
    const key = randomBytes(32)
    b.setKey(key)
    expect(b.getKey()!.equals(key)).toBe(true)
  })

  it('reads a pre-existing raw vault.key written by the pre-backend store (back-compat)', () => {
    const d = dir()
    const key = randomBytes(32)
    writeFileSync(join(d, 'vault.key'), key)
    expect(new FileKeyBackend(d).getKey()!.equals(key)).toBe(true)
  })

  it('rejects a corrupt key file', () => {
    const d = dir()
    writeFileSync(join(d, 'vault.key'), Buffer.from('short'))
    expect(() => new FileKeyBackend(d).getKey()).toThrow(/corrupt/)
  })
})

describe('KeyringKeyBackend', () => {
  function fakeEntry() {
    let stored: string | null = null
    return {
      entry: {
        getPassword: () => {
          if (stored === null) throw new Error('No matching entry found in secure storage')
          return stored
        },
        setPassword: (pw: string) => {
          stored = pw
        },
      },
      get stored() {
        return stored
      },
    }
  }

  it('roundtrips a key as base64 through the credential entry', () => {
    const fake = fakeEntry()
    const b = new KeyringKeyBackend({ entryFactory: () => fake.entry })
    const key = randomBytes(32)
    b.setKey(key)
    expect(fake.stored).toBe(key.toString('base64'))
    expect(b.getKey()!.equals(key)).toBe(true)
  })

  it('returns null when the credential store has no entry', () => {
    const fake = fakeEntry()
    const b = new KeyringKeyBackend({ entryFactory: () => fake.entry })
    expect(b.getKey()).toBeNull()
  })

  it('rejects a corrupt stored value', () => {
    const fake = fakeEntry()
    fake.entry.setPassword('bm90LTMyLWJ5dGVz') // "not-32-bytes"
    const b = new KeyringKeyBackend({ entryFactory: () => fake.entry })
    expect(() => b.getKey()).toThrow(/corrupt/)
  })

  // Real OS credential store; opt-in (KEYRING_TESTS=1) so CI runners without
  // an unlocked keychain / secret service don't flake.
  it.skipIf(!process.env.KEYRING_TESTS)('roundtrips through the real OS keychain', async () => {
    const service = `vault-test-${Date.now()}`
    const b = new KeyringKeyBackend({ service })
    const key = randomBytes(32)
    b.setKey(key)
    expect(b.getKey()!.equals(key)).toBe(true)
    const { Entry } = await import('@napi-rs/keyring')
    expect(new Entry(service, 'master-key').deletePassword()).toBe(true)
  })
})

describe('resolveKeyBackend', () => {
  it('defaults to the file backend', () => {
    expect(resolveKeyBackend(dir()).id).toBe('file')
  })

  it('selects keyring when VAULT_KEY_BACKEND=keyring', () => {
    process.env.VAULT_KEY_BACKEND = 'keyring'
    try {
      expect(resolveKeyBackend(dir()).id).toBe('keyring')
    } finally {
      delete process.env.VAULT_KEY_BACKEND
    }
  })
})

describe('SecretVault with an injected key backend', () => {
  function memoryBackend(): KeyBackend & { setCalls: number } {
    let key: Buffer | null = null
    return {
      id: 'memory',
      setCalls: 0,
      getKey: () => key,
      setKey(k: Buffer) {
        key = k
        this.setCalls++
      },
    }
  }

  it('generates the master key through the backend on first write and reuses it', () => {
    const d = dir()
    const backend = memoryBackend()
    const v1 = new SecretVault({ dir: d, keyBackend: backend })
    v1.set('API_KEY', 'sk-123')
    expect(backend.setCalls).toBe(1)
    expect(backend.getKey()!.length).toBe(32)

    // Second instance, same backend: decrypts what the first wrote.
    const v2 = new SecretVault({ dir: d, keyBackend: backend })
    expect(v2.get('API_KEY')).toBe('sk-123')
    expect(backend.setCalls).toBe(1)
  })

  it('keeps the legacy file behavior when no backend is passed', () => {
    const d = dir()
    const v = new SecretVault({ dir: d })
    v.set('TOKEN', 'abc')
    expect(existsSync(join(d, 'vault.key'))).toBe(true)
    expect(readFileSync(join(d, 'vault.key')).length).toBe(32)
    expect(new SecretVault({ dir: d }).get('TOKEN')).toBe('abc')
  })
})

void vi
