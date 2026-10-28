/**
 * Signed, single-use, 10-minute OAuth state for the sign-in relay.
 *
 * The relay signs {box, provider, nonce, exp} with HMAC-SHA256. The state names
 * the box it was minted for, so a hand-off can only ever go to that box. It is
 * single-use: the first successful verify records the nonce, a replay is
 * refused. No token is ever stored here, only the nonce of a used state.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const STATE_TTL_MS = 10 * 60_000
const MIN_SECRET_LEN = 32

export interface StatePayload {
  box: string
  provider: string
  nonce: string
}

export type VerifyResult =
  | { ok: true; payload: StatePayload & { exp: number } }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'replayed' }

/** Remembers used nonces until they could no longer verify anyway. */
export interface UsedStore {
  /** True if newly marked, false if it was already used. Must be atomic. */
  markUsed(key: string, expiresAt: number, now: number): Promise<boolean> | boolean
}

export class MemoryUsedStore implements UsedStore {
  private readonly seen = new Map<string, number>()
  markUsed(key: string, expiresAt: number, now: number = Date.now()): boolean {
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k)
    if (this.seen.has(key)) return false
    this.seen.set(key, expiresAt)
    return true
  }
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

export function signState(secret: string, p: StatePayload, now: number = Date.now()): string {
  if (secret.length < MIN_SECRET_LEN) throw new Error('relay signing secret must be at least 32 characters')
  const body = Buffer.from(JSON.stringify({ box: p.box, provider: p.provider, nonce: p.nonce, exp: now + STATE_TTL_MS })).toString('base64url')
  return `${body}.${mac(secret, body).toString('base64url')}`
}

export async function verifyState(secret: string, state: string, used: UsedStore, now: number = Date.now()): Promise<VerifyResult> {
  const parts = state.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' }
  const [body, sig] = parts
  const given = Buffer.from(sig, 'base64url')
  const want = mac(secret, body)
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'bad_signature' }
  let p: Partial<StatePayload & { exp: number }>
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof p.box !== 'string' || typeof p.provider !== 'string' || typeof p.nonce !== 'string' || typeof p.exp !== 'number') {
    return { ok: false, reason: 'malformed' }
  }
  if (now > p.exp) return { ok: false, reason: 'expired' }
  if (!(await used.markUsed(`${p.box}:${p.nonce}`, p.exp, now))) return { ok: false, reason: 'replayed' }
  return { ok: true, payload: { box: p.box, provider: p.provider, nonce: p.nonce, exp: p.exp } }
}
