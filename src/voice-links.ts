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
import { VOICE_LINK_TTL_HOURS } from './config.js'
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

/** Drop expired rows so a long-lived box doesn't accumulate dead tokens. */
function prune(now: number): void {
  getDb().prepare('DELETE FROM voice_links WHERE expires_at <= ?').run(now)
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
      .prepare('SELECT chat_id, expires_at FROM voice_links WHERE token = ?')
      .get(token) as { chat_id: string; expires_at: number } | undefined
    if (!row) return null
    if (row.expires_at <= now) {
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
 * One-way and one-shot: the link row is deleted in the same transaction that
 * writes the session, so the token in the URL bar is dead the moment the page
 * has a cookie. That is the whole point. A copy of the link left in browser
 * history, in a referrer, or in a log someone forgot to redact buys nothing.
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
    d.prepare('DELETE FROM voice_links WHERE token = ?').run(token)
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
  return [
    url,
    '',
    `Expires in ${hours}h. Opening it signs that browser in and the link itself stops working, so treat it like a password until you have used it and don't forward it.`,
    'Send /voice ui again for a fresh link (which signs the old browser out), or /voice ui revoke to sign out now.',
  ].join('\n')
}
