/**
 * Who a feature request is from (card #240): the owner's name, the
 * assistant's name and the box's address.
 *
 * Boxes set up before the first-chat profile (v1.40.0) have no
 * store/setup-answers.json, so the saved answers alone said "not set" for the
 * owner on those. The names are read the way the rest of the install already
 * reads them: the environment first, then the saved answers, then what setup
 * wrote into PERSONALITY.md and CLAUDE.md.
 */
import { PROVISIONAL } from '../setup/saved.js'
import { assistantName as assistantNameFromFiles } from '../shortcut-setup.js'

export interface SenderSources {
  env: { OWNER_NAME?: string; ASSISTANT_NAME?: string }
  saved: { ownerName?: unknown; assistantName?: unknown } | null
  personality: string | null
  claudeMd: string | null
}

function clean(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Empty when nothing names the owner: a stand-in is never passed off as a name. */
export function resolveOwnerName(s: SenderSources): string {
  const env = clean(s.env.OWNER_NAME)
  if (env) return env
  const saved = clean(s.saved?.ownerName)
  if (saved && saved !== PROVISIONAL.ownerName) return saved
  const fromClaude = s.claudeMd?.match(/^You are (.+?)'s personal AI assistant/m)?.[1]?.trim() ?? ''
  return fromClaude && !fromClaude.includes('{{') ? fromClaude : ''
}

/** Empty when nothing names the assistant. */
export function resolveAssistantName(s: SenderSources): string {
  return clean(s.env.ASSISTANT_NAME) || assistantNameFromFiles(s.personality, s.claudeMd) || clean(s.saved?.assistantName)
}
