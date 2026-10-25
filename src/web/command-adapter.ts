/**
 * The platform adapter a web chat command talks to.
 *
 * Slash commands run through the same router Telegram and Teams use (routeText
 * in bot.ts), and that router only knows how to answer through a
 * PlatformAdapter. This one writes what the command says into the web
 * conversation instead of a chat: each sendMessage becomes an assistant
 * message, buttons and all. The web page renders markdown itself, so text
 * passes through unformatted and unsplit.
 */
import type { PlatformAdapter, SendOptions } from '../platform/types.js'

/** The id the router sees for the owner's own message, so /secret can delete it. */
export const WEB_USER_MESSAGE_ID = 'web:user'

export interface WebCommandHooks {
  /** A reply to show. Returns the id later edits and button clears refer to. */
  send(text: string, buttons: string[]): string
  /** The command edited a reply it sent (rare: streaming previews are off). */
  edit(id: string, text: string): void
  /** The command took the buttons off a reply. */
  clearButtons(id: string): void
  /** The command deleted the owner's message (a pasted key): it must not be stored. */
  dropUserMessage(): void
  /** A file the command (or a turn it started) handed over. */
  file(path: string, kind: 'voice' | 'document' | 'photo'): void
}

export function createWebCommandAdapter(hooks: WebCommandHooks): PlatformAdapter {
  return {
    name: 'web',
    maxMessageLength: 100_000,
    supportsEdit: false,
    supportsButtons: true,
    async start() {},
    async stop() {},
    async sendMessage(_chatId: string, text: string, options?: SendOptions) {
      return hooks.send(text, options?.buttons ?? [])
    },
    async editMessage(_chatId: string, messageId: string, text: string) {
      hooks.edit(messageId, text)
    },
    async sendTyping() {},
    async sendFile(_chatId: string, filePath: string, type: 'voice' | 'document' | 'photo') {
      hooks.file(filePath, type)
    },
    async answerCallback() {},
    async clearButtons(_chatId: string, messageId: string) {
      hooks.clearButtons(messageId)
    },
    async deleteMessage(_chatId: string, messageId: string) {
      if (messageId !== WEB_USER_MESSAGE_ID) return false
      hooks.dropUserMessage()
      return true
    },
    formatText: (markdown: string) => markdown,
    splitMessage: (text: string) => [text],
    onMessage() {},
    onActivity() {},
  }
}
