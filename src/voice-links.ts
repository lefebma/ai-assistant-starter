/**
 * Per-chat links to the voice UI.
 *
 * The voice page used to be reached with HTTP_BEARER_TOKEN in the query string,
 * baked into the Caddyfile at deploy time. That made the operator a permanent
 * key-holder for every user's assistant: the same token sits in .env, which the
 * operator reads to provision the box. These links are minted on demand by the
 * user, from inside their own chat, and expire.
 *
 * The token doubles as the API credential (the page sends it as
 * `Authorization: Bearer`), so its lifetime is the usable session length rather
 * than a few minutes. Minting revokes the chat's previous link, so a lost phone
 * is one `/voice ui` away from being locked out.
 *
 * This does NOT lock out root: anyone who can read the box's SQLite file or
 * .env can still reach the assistant. It removes the standing key from normal
 * operation, so access requires a deliberate act rather than a file the
 * operator already has open.
 */
import { randomBytes } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { VOICE_LINK_TTL_HOURS, VOICE_LINK_GRACE_MINUTES } from './config.js'
import { createVoiceSession, revokeVoiceSessions, type VoiceSession } from './voice-sessions.js'

export interface VoiceLink {
  token: string
  chatId: string
  expiresAt: number
}

/** URL-safe, 256 bits. Long enough that guessing is not a threat model. */
function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function ttlMs(): number {
  return Math.max(1, VOICE_LINK_TTL_HOURS) * 60 * 60 * 1000
}

function graceMs(): number {
  return Math.max(0, VOICE_LINK_GRACE_MINUTES) * 60 * 1000
}

/**
 * Drop rows that can no longer be used: past their expiry, or past the grace
 * window that started when the first browser opened them.
 */
function prune(now: number): void {
  const d = getDb()
  d.prepare('DELETE FROM voice_links WHERE expires_at <= ?').run(now)
  d.prepare('DELETE FROM voice_links WHERE used_at IS NOT NULL AND used_at + ? <= ?').run(graceMs(), now)
}

/**
 * Issue a link for one chat, invalidating that chat's previous link.
 * One live link per chat: re-running the command is also how you revoke a
 * link you handed to the wrong device.
 */
export function mintVoiceLink(chatId: string, now: number = Date.now()): VoiceLink {
  const d = getDb()
  prune(now)
  d.prepare('DELETE FROM voice_links WHERE chat_id = ?').run(chatId)
  // A new link supersedes the old one, and a session opened from the old link
  // is the same grant by another name. Leaving it alive would mean the phone
  // you minted a replacement to lock out kept talking.
  revokeVoiceSessions(chatId)
  const token = newToken()
  const expiresAt = now + ttlMs()
  d.prepare(
    'INSERT INTO voice_links (token, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, chatId, now, expiresAt)
  return { token, chatId, expiresAt }
}

/**
 * The chat a token belongs to, or null if unknown or expired.
 *
 * Fails closed. This runs on an unauthenticated request path, so a database
 * problem must deny access rather than throw: an exception here escapes the
 * HTTP request handler as an uncaught error and takes the process with it.
 */
export function resolveVoiceToken(token: string, now: number = Date.now()): string | null {
  if (!token) return null
  try {
    const row = getDb()
      .prepare('SELECT chat_id, expires_at, used_at FROM voice_links WHERE token = ?')
      .get(token) as { chat_id: string; expires_at: number; used_at: number | null } | undefined
    if (!row) return null
    // The grace window is the shorter leash, but it never outlives the link:
    // one opened a minute before expiry does not get ten more.
    const deadAt = row.used_at === null ? row.expires_at : Math.min(row.expires_at, row.used_at + graceMs())
    if (deadAt <= now) {
      getDb().prepare('DELETE FROM voice_links WHERE token = ?').run(token)
      return null
    }
    return row.chat_id
  } catch (err) {
    logger.error({ err }, 'voice link lookup failed; denying')
    return null
  }
}

/**
 * Spend a link and open a browser session with it.
 *
 * First use starts a short clock (VOICE_LINK_GRACE_MINUTES, default 10)
 * rather than killing the link outright. Long enough to open the page on the
 * machine you read the message on and then on your phone, which is the way
 * people actually use it; short enough that the copy left behind in browser
 * history, in a referrer, or in a log someone forgot to redact is worthless
 * by the time anyone finds it.
 *
 * 1.23.0 made this strictly single use and that was wrong: the second device
 * is not an edge case, it is the point of the feature.
 *
 * Deliberately not reached by a GET. A link preview fetcher (Telegram makes
 * one for every URL posted in a chat) would otherwise burn the link before the
 * human tapped it, and the feature would appear broken to everyone. Only the
 * page's own POST, which needs JavaScript, gets here.
 */
export function exchangeVoiceToken(token: string, now: number = Date.now()): VoiceSession | null {
  const chatId = resolveVoiceToken(token, now)
  if (!chatId) return null
  const d = getDb()
  const row = d.prepare('SELECT expires_at FROM voice_links WHERE token = ?').get(token) as
    | { expires_at: number }
    | undefined
  if (!row) return null
  const spend = d.transaction((): VoiceSession => {
    // Stamped once, on first use. Later exchanges inside the window ride the
    // original stamp, so a second device cannot extend the leash by arriving.
    d.prepare('UPDATE voice_links SET used_at = ? WHERE token = ? AND used_at IS NULL').run(now, token)
    return createVoiceSession(chatId, row.expires_at, now)
  })
  try {
    return spend()
  } catch (err) {
    logger.error({ err }, 'voice session exchange failed; denying')
    return null
  }
}

/** Returns how many links were dropped, so the caller can say "nothing to revoke". */
export function revokeVoiceLinks(chatId: string): number {
  const info = getDb().prepare('DELETE FROM voice_links WHERE chat_id = ?').run(chatId)
  // Counted together: to the user this is one thing ("kill my voice access"),
  // and reporting "nothing to revoke" while a live browser session carries on
  // would be worse than wrong.
  return info.changes + revokeVoiceSessions(chatId)
}

/** The URL a user opens. https only: the edge terminates TLS and the mic needs a secure context. */
export function voiceLinkUrl(hostname: string, token: string): string {
  return `https://${hostname}/voice?token=${encodeURIComponent(token)}`
}

/**
 * The chat-facing message for a freshly minted link. Kept here so the wording
 * (which is the only warning a user gets that the link is a credential) is
 * covered by tests rather than buried in the command switch.
 */
export function voiceLinkMessage(url: string, expiresAt: number, now: number = Date.now()): string {
  const hours = Math.max(1, Math.round((expiresAt - now) / (60 * 60 * 1000)))
  const GRACE = Math.max(1, VOICE_LINK_GRACE_MINUTES)
  return [
    url,
    '',
    `Expires in ${hours}h. Opening it signs that browser in; it keeps working for ${GRACE} more minutes so you can open it on a second device, then stops. Treat it like a password and don't forward it.`,
    'Send /voice ui again for a fresh link (which signs the old browsers out), or /voice ui revoke to sign out now.',
  ].join('\n')
}
