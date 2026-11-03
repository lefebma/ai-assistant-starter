/**
 * Each chat's /effort choice (card #272), kept in app_state so it survives a
 * restart, like its /model choice. A web conversation keeps its own choice in
 * web_conversations.effort.
 */
import { getAppState, setAppState } from '../db.js'
import { isEffort, type Effort } from './effort-levels.js'

const key = (chatId: string) => `chat_effort:${chatId}`

/** The chat's choice, or undefined for the default. */
export function getChatEffort(chatId: string): Effort | undefined {
  const v = getAppState(key(chatId))
  return isEffort(v) ? v : undefined
}

/** Store a choice; '' goes back to the default. */
export function setChatEffort(chatId: string, effort: Effort | ''): void {
  setAppState(key(chatId), effort)
}
