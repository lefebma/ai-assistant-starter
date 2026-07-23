/**
 * tests/vault-crypto.test.ts
 *
 * BYOK vault (Phase 4 slice a): the AEAD primitive underneath the secret store.
 * Authenticated encryption (AES-256-GCM) with a full-entropy 32-byte key and a
 * fresh random IV per call. Guards, per the crypto-audit playbook: no plaintext
 * in the envelope, unique IVs, and decryption fails closed on a wrong key or a
 * tampered ciphertext (the GCM tag).
 */
import { describe, it, expect } from 'vitest'
import { encrypt, decrypt, newKey } from '../src/vault/crypto.js'

describe('vault crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const key = newKey()
    const env = encrypt('sk-secret-123', key)
    expect(decrypt(env, key)).toBe('sk-secret-123')
  })

  it('newKey returns 32 bytes of entropy and two keys differ', () => {
    const a = newKey()
    const b = newKey()
    expect(a.length).toBe(32)
    expect(a.equals(b)).toBe(false)
  })

  it('never stores plaintext in the envelope and tags it with version + algorithm', () => {
    const env = encrypt('topsecret-value', newKey())
    expect(JSON.stringify(env)).not.toContain('topsecret-value')
    expect(env.v).toBe(1)
    expect(env.alg).toBe('aes-256-gcm')
  })

  it('uses a fresh IV each time (same plaintext -> different ciphertext)', () => {
    const key = newKey()
    const a = encrypt('same', key)
    const b = encrypt('same', key)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('fails closed when decrypting with the wrong key', () => {
    const env = encrypt('x', newKey())
    expect(() => decrypt(env, newKey())).toThrow()
  })

  it('fails closed when the ciphertext is tampered (GCM tag mismatch)', () => {
    const key = newKey()
    const env = encrypt('x', key)
    const tampered = { ...env, ct: Buffer.from('deadbeefdeadbeef', 'hex').toString('base64') }
    expect(() => decrypt(tampered, key)).toThrow()
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encrypt('x', Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})
