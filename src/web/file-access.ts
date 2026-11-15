/**
 * Which chat may see which uploads (card #292). files.ts decides what is
 * visible at all; this decides whose it is.
 *
 * The main chat (the owner) sees everything. Any other chat sees, inside the
 * uploads folder, only:
 * - `chat/<conversation>/` for conversations it owns,
 * - `projects/<id>/` for projects it owns,
 * - `tray/<its own key>/`, the chat box uploads it has not sent yet.
 * Loose files at the top of the uploads folder have no recorded owner
 * (Telegram downloads, spoken replies), so they stay out.
 *
 * Answers from the canonical path. A case-insensitive disk would otherwise let
 * `WORKSPACE/Uploads/...` slip past a comparison with the spelling as written.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { PRIMARY_CHAT_ID } from '../config.js'
import { getConversation } from './conversations.js'
import { getProject } from '../projects/store.js'
import { getFileRoots, listDir, resolveVisible, type DirEntry } from './files.js'

const isMainChat = (chatId: string): boolean => PRIMARY_CHAT_ID !== '' && chatId === PRIMARY_CHAT_ID

/** The folder name a chat's unsent uploads live under. */
export function trayKey(chatId: string): string {
  return chatId.replace(/[^\w-]/g, '_') || '_'
}

/** Where the chat box puts one chat's uploads until they are sent. */
export function trayDir(chatId: string): string {
  return join(getFileRoots().uploadsDir, 'tray', trayKey(chatId))
}

export function chatMaySee(chatId: string, abs: string): boolean {
  if (isMainChat(chatId)) return true
  let rel: string
  try {
    rel = relative(realpathSync.native(getFileRoots().uploadsDir), realpathSync.native(abs))
  } catch {
    return false
  }
  if (rel === '') return true // the uploads folder itself; its entries are filtered
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return true
  const [top, owner] = rel.split(sep)
  if (top !== 'chat' && top !== 'projects' && top !== 'tray') return false
  if (owner === undefined) return true // the folder itself; its entries are filtered
  if (top === 'chat') return getConversation(chatId, owner) !== null
  if (top === 'projects') return getProject(chatId, owner) !== null
  return owner === trayKey(chatId)
}

/** `resolveVisible`, for one chat. Null also when the file is another chat's. */
export function resolveForChat(relPath: string, chatId: string): ReturnType<typeof resolveVisible> {
  const found = resolveVisible(relPath)
  return found && chatMaySee(chatId, found.abs) ? found : null
}

/** `listDir`, for one chat: another chat's entries are left out. */
export function listDirForChat(relPath: string, chatId: string): { entries: DirEntry[] } | null {
  if (!resolveForChat(relPath, chatId)) return null
  return listDir(relPath, undefined, (abs) => chatMaySee(chatId, abs))
}
