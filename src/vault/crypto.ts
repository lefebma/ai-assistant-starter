/**
 * Authenticated encryption for the BYOK vault (Phase 4 slice a).
 *
 * AES-256-GCM: confidentiality + integrity in one primitive. The key is a
 * full-entropy 32-byte random value (no passphrase KDF that could be the weak
 * link), a fresh 96-bit IV is drawn per encryption, and the 128-bit GCM tag
 * makes decryption fail closed on any tampering or a wrong key.
 *
 * This is a leaf module (Node's built-in crypto only) so it is trivially
 * unit-testable and adds no dependency.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12 // 96-bit nonce, the GCM standard

/** Serializable ciphertext envelope. All binary fields are base64. */
export type Envelope = { v: 1; alg: 'aes-256-gcm'; iv: string; tag: string; ct: string }

/** A fresh 256-bit key from the CSPRNG. */
export function newKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function encrypt(plaintext: string, key: Buffer): Envelope {
  if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  }
}

export function decrypt(env: Envelope, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`)
  const decipher = createDecipheriv(ALG, key, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()])
  return pt.toString('utf8')
}
