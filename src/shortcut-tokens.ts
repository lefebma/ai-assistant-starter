/**
 * Per-chat credentials for Apple Shortcuts (card #152).
 *
 * A Shortcut is a small program on the owner's phone or Mac that posts a
 * question to /api/shortcut and shows or speaks the answer. It needs a key it
 * can keep, which rules out the voice link: that expires in hours, and a
 * Shortcut that stops working overnight is not a feature anyone keeps.
 *
 * So this key does not expire. What makes that tolerable:
 *   - it belongs to one chat, is minted by that chat, and answers as that chat
 *     (never the box-wide HTTP_BEARER_TOKEN, which the operator also holds)
 *   - minting a new one replaces the old, and `/shortcut revoke` kills it, so a
 *     lost phone is one command away from locked out
 *   - only a SHA-256 of it is stored. The token is 256 random bits, so a plain
 *     hash is enough; a slow KDF guards low-entropy passwords, not this
 *   - a chat that loses its authorization loses its key with it (checked at
 *     use, in http-server.ts, so there is no second list to forget to update)
 */
import { createHash, randomBytes } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'

/** Recognisable in a leaked paste or a secret scanner, and nothing else. */
export const SHORTCUT_TOKEN_PREFIX = 'hvs_'

export function hashShortcutToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Issue this chat's key, replacing any it had. Returns the only plaintext copy. */
export function mintShortcutToken(chatId: string, now: number = Date.now()): string {
  const token = SHORTCUT_TOKEN_PREFIX + randomBytes(32).toString('base64url')
  getDb()
    .prepare(
      `INSERT INTO shortcut_tokens (chat_id, token_hash, created_at, last_used_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_at = excluded.created_at,
         last_used_at = NULL`
    )
    .run(chatId, hashShortcutToken(token), now)
  return token
}

export function revokeShortcutToken(chatId: string): boolean {
  return getDb().prepare('DELETE FROM shortcut_tokens WHERE chat_id = ?').run(chatId).changes > 0
}

export interface ShortcutTokenInfo {
  createdAt: number
  lastUsedAt: number | null
}

export function shortcutTokenInfo(chatId: string): ShortcutTokenInfo | null {
  const row = getDb()
    .prepare('SELECT created_at, last_used_at FROM shortcut_tokens WHERE chat_id = ?')
    .get(chatId) as { created_at: number; last_used_at: number | null } | undefined
  return row ? { createdAt: row.created_at, lastUsedAt: row.last_used_at } : null
}

/**
 * The chat a presented key belongs to, or null.
 *
 * Fails closed: this runs on an unauthenticated path, and an exception here
 * would escape the request handler. Lookup is by hash, so there is no
 * character-by-character comparison of the secret to time.
 */
export function resolveShortcutToken(token: string, now: number = Date.now()): string | null {
  if (!token.startsWith(SHORTCUT_TOKEN_PREFIX)) return null
  try {
    const d = getDb()
    const hash = hashShortcutToken(token)
    const row = d.prepare('SELECT chat_id FROM shortcut_tokens WHERE token_hash = ?').get(hash) as
      | { chat_id: string }
      | undefined
    if (!row) return null
    d.prepare('UPDATE shortcut_tokens SET last_used_at = ? WHERE token_hash = ?').run(now, hash)
    return row.chat_id
  } catch (err) {
    logger.error({ err }, 'shortcut token lookup failed; denying')
    return null
  }
}
