/**
 * Browser sessions for the voice page.
 *
 * The link minted by `/voice ui` carries its token in the query string, and
 * that token doubles as the API credential. A URL is the wrong place to keep a
 * credential: it lands in browser history, in the Referer header of any
 * outbound link, and in anything that logs URLs. The hosted access log redacts
 * `?token=` for exactly that reason, which is a mitigation and not a fix.
 *
 * So the link buys a session, once. The page posts its token to
 * /api/voice-session, gets an HttpOnly cookie back, and drops the token out of
 * the address bar. The token is spent at that moment, so the copy left behind
 * in history or a log is worth nothing.
 *
 * The cookie is a plain opaque id looked up here rather than a signed blob:
 * revocation has to be immediate (`/voice ui revoke` is the answer to a lost
 * phone), and a self-contained token cannot be taken back.
 */
import { randomBytes } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'

/**
 * No `__Host-` prefix. It would force Secure, and a box reached over plain
 * http://localhost during development could then never set the cookie at all
 * (Safari rejects Secure over http even on localhost). The prefix defends
 * against a sibling subdomain shadowing the cookie, which is not a shape a
 * single-hostname box has.
 */
export const VOICE_COOKIE = 'havn_voice'

export interface VoiceSession {
  id: string
  chatId: string
  expiresAt: number
}

/** URL-safe, 256 bits, same budget as the link token it replaces. */
function newId(): string {
  return randomBytes(32).toString('base64url')
}

function prune(now: number): void {
  getDb().prepare('DELETE FROM voice_sessions WHERE expires_at <= ?').run(now)
}

/**
 * Start a session for a chat.
 *
 * `expiresAt` is the link's expiry, not a fresh clock. The chat message said
 * "expires in 12h"; restarting the clock on first load would make that a lie,
 * and would let a link sat on for eleven hours buy another twelve.
 */
export function createVoiceSession(chatId: string, expiresAt: number, now: number = Date.now()): VoiceSession {
  const d = getDb()
  prune(now)
  const id = newId()
  d.prepare(
    'INSERT INTO voice_sessions (id, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, chatId, now, expiresAt)
  return { id, chatId, expiresAt }
}

/**
 * The chat a session belongs to, or null if unknown or expired.
 *
 * Fails closed, and for the same reason resolveVoiceToken does: this runs on an
 * unauthenticated request path, where a thrown exception escapes the handler as
 * an uncaught error and takes the process with it.
 */
export function resolveVoiceSession(id: string, now: number = Date.now()): string | null {
  if (!id) return null
  try {
    const row = getDb()
      .prepare('SELECT chat_id, expires_at FROM voice_sessions WHERE id = ?')
      .get(id) as { chat_id: string; expires_at: number } | undefined
    if (!row) return null
    if (row.expires_at <= now) {
      getDb().prepare('DELETE FROM voice_sessions WHERE id = ?').run(id)
      return null
    }
    return row.chat_id
  } catch (err) {
    logger.error({ err }, 'voice session lookup failed; denying')
    return null
  }
}

/** Returns how many sessions were dropped. */
export function revokeVoiceSessions(chatId: string): number {
  return getDb().prepare('DELETE FROM voice_sessions WHERE chat_id = ?').run(chatId).changes
}

/** The session id in a Cookie header, or '' if it carries none of ours. */
export function sessionIdFromCookies(header: string | undefined): string {
  if (!header) return ''
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== VOICE_COOKIE) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return ''
}

/**
 * The Set-Cookie line for a fresh session.
 *
 * SameSite=Lax rather than Strict on purpose. Strict would withhold the cookie
 * on a top-level navigation from another site, and arriving from a link in a
 * chat app is exactly that: a returning visitor would look anonymous and be
 * sent back for a new link every time. Lax still keeps the cookie off
 * cross-site subresource requests and cross-site POSTs, which is the CSRF
 * surface that matters here.
 */
export function voiceSessionCookie(session: VoiceSession, secure: boolean, now: number = Date.now()): string {
  const maxAge = Math.max(1, Math.floor((session.expiresAt - now) / 1000))
  const parts = [
    `${VOICE_COOKIE}=${session.id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
