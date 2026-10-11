/**
 * The one-time setup link for a hosted box (card #213).
 *
 * Until setup is done, the setup page is on the public internet, and whoever
 * fills it in first decides whose bot the assistant answers to. So the page
 * only answers at a URL carrying a random token, and:
 *
 * - only a SHA-256 of the token is stored, so the file on disk is not a link;
 * - it expires after 48 hours (an expired link says so, rather than 404ing,
 *   so the client knows to ask for a new one);
 * - finishing setup consumes it for good: from then on every /setup request
 *   is a 404, whatever token it carries. Only the operator, on the box, can
 *   issue another.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const LINK_TTL_MS = 48 * 60 * 60 * 1000

export interface LinkState {
  /** sha256 of the token, hex. Null once setup has completed. */
  hash: string | null
  expiresAt: number
  completedAt?: number
}

export interface LinkStore {
  read(): LinkState | null
  write(state: LinkState): void
}

export type LinkCheck = 'ok' | 'expired' | 'invalid' | 'done' | 'none'

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function issueLink(store: LinkStore, now: number, random: () => Buffer = () => randomBytes(32)): string {
  const token = random().toString('base64url')
  store.write({ hash: sha256(token), expiresAt: now + LINK_TTL_MS })
  return token
}

export function checkLink(store: LinkStore, token: string | null | undefined, now: number): LinkCheck {
  const state = store.read()
  if (!state) return 'none'
  if (state.completedAt || !state.hash) return 'done'
  if (!token) return 'invalid'
  const given = Buffer.from(sha256(token), 'hex')
  const want = Buffer.from(state.hash, 'hex')
  if (given.length !== want.length || !timingSafeEqual(given, want)) return 'invalid'
  return now > state.expiresAt ? 'expired' : 'ok'
}

export function completeLink(store: LinkStore, now: number): void {
  const state = store.read()
  store.write({ hash: null, expiresAt: state?.expiresAt ?? now, completedAt: now })
}

export function fileLinkStore(path: string): LinkStore {
  return {
    read: () => {
      if (!existsSync(path)) return null
      try {
        const s = JSON.parse(readFileSync(path, 'utf-8')) as LinkState
        return typeof s.expiresAt === 'number' ? s : null
      } catch {
        return null
      }
    },
    write: (state) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
    },
  }
}

/**
 * Bad-token hits allowed per window, per client address. A 256-bit token is
 * not guessable anyway; this keeps a scanner from filling the log. It only
 * ever counts failures, and a valid token is checked before it, so nobody can
 * lock the real client out by hammering the page.
 */
export class FailureLimiter {
  private hits = new Map<string, number[]>()
  constructor(private readonly max = 20, private readonly windowMs = 10 * 60 * 1000) {}
  private recent(client: string, now: number): number[] {
    const kept = (this.hits.get(client) ?? []).filter((t) => now - t < this.windowMs)
    if (kept.length) this.hits.set(client, kept)
    else this.hits.delete(client)
    return kept
  }
  blocked(client: string, now: number): boolean {
    return this.recent(client, now).length >= this.max
  }
  record(client: string, now: number): void {
    // Bounded: a flood of distinct addresses cannot grow this without limit.
    if (this.hits.size > 10_000) this.hits.clear()
    this.hits.set(client, [...this.recent(client, now), now])
  }
}
