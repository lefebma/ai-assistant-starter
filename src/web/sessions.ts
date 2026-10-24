/**
 * Sign-in links and browser sessions for the web app (/app).
 *
 * `/app` in an allowed chat mints a link that works once and expires in 15
 * minutes. The page trades the token (carried in the URL fragment, which is
 * never sent to a server or a Referer header) for an HttpOnly cookie. Only
 * SHA-256 hashes of the token and the session id are stored: both are 256
 * random bits, so a plain hash is enough and the database is not a list of
 * working credentials.
 */
import { createHash, randomBytes } from 'node:crypto'
import { getDb } from '../db.js'
import { PUBLIC_HOSTNAME, HTTP_PORT } from '../config.js'
import { reachableBase } from '../shortcut-setup.js'

export const WEB_COOKIE = 'havn_web'
export const LINK_TTL_MS = 15 * 60_000
export const SESSION_TTL_MS = 30 * 24 * 3600_000
const SLIDE_AFTER_MS = 3600_000

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function mintWebLink(chatId: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const d = getDb()
  d.prepare('DELETE FROM web_link_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(now)
  d.prepare('DELETE FROM web_link_tokens WHERE chat_id = ? AND used_at IS NULL').run(chatId)
  const token = newSecret()
  const expiresAt = now + LINK_TTL_MS
  d.prepare('INSERT INTO web_link_tokens (token_hash, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hash(token),
    chatId,
    now,
    expiresAt
  )
  return { token, expiresAt }
}

export function exchangeWebLink(
  token: string,
  label: string,
  now: number = Date.now()
): { sessionId: string; chatId: string; expiresAt: number } | null {
  if (!token) return null
  const d = getDb()
  const h = hash(token)
  const row = d.prepare('SELECT chat_id, expires_at, used_at FROM web_link_tokens WHERE token_hash = ?').get(h) as
    | { chat_id: string; expires_at: number; used_at: number | null }
    | undefined
  if (!row || row.used_at !== null || row.expires_at <= now) return null
  // Claim atomically: a concurrent second exchange sees zero changes.
  const claimed = d
    .prepare('UPDATE web_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
    .run(now, h).changes
  if (claimed !== 1) return null
  const sessionId = newSecret()
  const expiresAt = now + SESSION_TTL_MS
  d.prepare(
    'INSERT INTO web_sessions (id_hash, chat_id, label, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(hash(sessionId), row.chat_id, label.slice(0, 120), now, expiresAt, now)
  return { sessionId, chatId: row.chat_id, expiresAt }
}

export function resolveWebSession(
  sessionId: string,
  now: number = Date.now()
): { chatId: string; idHash: string } | null {
  if (!sessionId) return null
  const d = getDb()
  const idHash = hash(sessionId)
  const row = d.prepare('SELECT chat_id, expires_at, last_seen_at FROM web_sessions WHERE id_hash = ?').get(idHash) as
    | { chat_id: string; expires_at: number; last_seen_at: number }
    | undefined
  if (!row) return null
  if (row.expires_at <= now) {
    d.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(idHash)
    return null
  }
  if (now - row.last_seen_at > SLIDE_AFTER_MS) {
    d.prepare('UPDATE web_sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?').run(
      now + SESSION_TTL_MS,
      now,
      idHash
    )
  }
  return { chatId: row.chat_id, idHash }
}

export function listWebSessions(
  chatId: string
): { idHash: string; label: string; createdAt: number; lastSeenAt: number }[] {
  const rows = getDb()
    .prepare(
      'SELECT id_hash, label, created_at, last_seen_at FROM web_sessions WHERE chat_id = ? ORDER BY last_seen_at DESC'
    )
    .all(chatId) as { id_hash: string; label: string; created_at: number; last_seen_at: number }[]
  return rows.map((r) => ({ idHash: r.id_hash, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at }))
}

export function revokeWebSession(chatId: string, idHash: string): boolean {
  return getDb().prepare('DELETE FROM web_sessions WHERE chat_id = ? AND id_hash = ?').run(chatId, idHash).changes > 0
}

export function revokeOtherWebSessions(chatId: string, keepIdHash: string): number {
  return getDb().prepare('DELETE FROM web_sessions WHERE chat_id = ? AND id_hash != ?').run(chatId, keepIdHash).changes
}

export function revokeAllWebSessions(chatId: string): number {
  return getDb().prepare('DELETE FROM web_sessions WHERE chat_id = ?').run(chatId).changes
}

export function webSessionCookie(sessionId: string, secure: boolean, maxAgeMs: number): string {
  return `${WEB_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`
}

export function clearWebCookie(secure: boolean): string {
  return webSessionCookie('', secure, 0)
}

export function webSessionFromCookies(header?: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== WEB_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Where to send the owner. The public name when the box has one, else its LAN
 * address (reachable from a phone on the same Wi-Fi), else null.
 */
export function webAppUrl(
  token: string,
  publicHostname: string = PUBLIC_HOSTNAME,
  httpPort: number = HTTP_PORT,
  lanAddress?: string | null
): string | null {
  const target = lanAddress === undefined ? reachableBase(publicHostname, httpPort) : reachableBase(publicHostname, httpPort, lanAddress)
  return target ? `${target.base}/app#token=${token}` : null
}
