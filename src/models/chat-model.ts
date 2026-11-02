/**
 * Each chat's /model choice (card #270), kept in app_state so it survives a
 * restart. Telegram and Teams chats use this; a web conversation keeps its own
 * choice in web_conversations.model.
 */
import { getAppState, setAppState } from '../db.js'

const key = (chatId: string) => `chat_model:${chatId}`

/** The chat's choice, or undefined for the box default. */
export function getChatModel(chatId: string): string | undefined {
  return getAppState(key(chatId)) || undefined
}

/** Store a choice; '' goes back to the box default. */
export function setChatModel(chatId: string, ref: string): void {
  setAppState(key(chatId), ref)
}
