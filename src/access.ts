/**
 * Who is allowed to talk to the assistant.
 *
 * An install is "unconfigured" until ALLOWED_CHAT_ID is filled in. That state
 * used to authorize everyone, on the assumption that nobody would have the
 * assistant running before they had locked it down. The setup wizard now
 * offers to start it in the background at the end of setup, which happens
 * before the owner has a chat ID to lock it with, so that assumption no longer
 * holds and the open window is real.
 *
 * Failing fully closed is not an option: the owner learns their chat ID by
 * asking the bot for it. So an unconfigured install answers exactly the
 * commands needed to finish setup and refuses everything else, including every
 * path that would reach the model or the owner's data.
 */

import { commandWord } from './infra/command-text.js'

/** Commands an unconfigured install will still answer. */
const BOOTSTRAP_COMMANDS = new Set(['/chatid', '/start', '/help'])

export interface SenderQuery {
  chatId: string
  /** ALLOWED_CHAT_ID, empty when the install has not been locked down yet. */
  primaryChatId: string
  /** Additional chats authorized via /authorize add. */
  isExtraChat(chatId: string): boolean
}

export interface AccessQuery extends SenderQuery {
  text: string
}

export interface AccessDecision {
  allow: boolean
  /** What to send back when refusing. Absent when allowed. */
  reply?: string
}

/**
 * Whether chatId is a sender decideAccess would ever grant content-bearing
 * access to. Ignores the bootstrap-command carve-out, which only applies to
 * a handful of setup text commands and never to media - a platform adapter
 * deciding whether it is safe to download an attachment on this chat's
 * behalf wants this check, not the full decideAccess text-routing decision.
 */
export function isAuthorizedSender(q: SenderQuery): boolean {
  return !!q.primaryChatId && (q.chatId === q.primaryChatId || q.isExtraChat(q.chatId))
}

export function decideAccess(q: AccessQuery): AccessDecision {
  if (!q.primaryChatId) {
    // Same normalisation the router uses. When these two disagreed, `/chatID`
    // was allowed through here and then matched no handler, so the one command
    // that has to work on an unconfigured install reached the model instead.
    if (BOOTSTRAP_COMMANDS.has(commandWord(q.text))) return { allow: true }
    return {
      allow: false,
      // Deliberately not the "/authorize add <id>" wording used below: that
      // tells a stranger the install is unclaimed and hands them the exact
      // command to ask for. This says only what the owner needs.
      reply:
        'This assistant is not set up yet.\n\n' +
        'If you are the owner: send /chatid, put the number it gives you in the ' +
        'ALLOWED_CHAT_ID line of your .env file, and restart.',
    }
  }

  if (isAuthorizedSender(q)) return { allow: true }

  return {
    allow: false,
    reply: `Not authorized. Chat ID: ${q.chatId}\nAsk the owner to run: /authorize add ${q.chatId} from the primary chat.`,
  }
}
