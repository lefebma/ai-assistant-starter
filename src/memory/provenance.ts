/**
 * Memory provenance (card #235, spike #217 defects 11 and 12).
 *
 * Every memory records where it came from. Recall keeps the owner's own words
 * and the assistant's replies as plain background, and puts anything learned
 * from outside (an email or web page a tool read, a forwarded message) inside
 * an untrusted wrapper, so the model reads it as data, never as an instruction.
 * No stored text can open or close one of the context blocks around it.
 */
import type { Memory, MemoryOrigin } from '../db.js'
import { defang, wrapUntrusted } from '../prompt-safety.js'

/** Evidence types that mean a turn's tools read text the owner did not write. */
export const OUTSIDE_READS = ['mail.read', 'web.read', 'source.read'] as const

/** The origin of an assistant reply, from what the turn's tools read. */
export function replyOrigin(reads: readonly string[] | undefined, quoted = false): 'assistant' | 'untrusted' {
  // A reply to a forwarded or quoted message may repeat it, like one written after a tool read.
  if (quoted) return 'untrusted'
  return reads?.some((r) => (OUTSIDE_READS as readonly string[]).includes(r)) ? 'untrusted' : 'assistant'
}

/** True when a recalled memory must reach the model inside an untrusted wrapper. */
export function isUntrusted(m: Pick<Memory, 'origin' | 'content'>): boolean {
  if (m.origin === 'untrusted') return true
  // Written before provenance: only the owner's own words are known to be
  // safe, and not even those when they carried a forwarded or quoted block.
  return m.origin === 'legacy' && (!m.content.startsWith('User said:') || /<\s*\/?\s*untrusted-/i.test(m.content))
}

export { defang }

/** The line a memory contributes to the memory block. */
export function recallLine(m: Pick<Memory, 'origin' | 'content'>, maxLen = 400): string {
  const content = defang(m.content)
  return isUntrusted(m) ? wrapUntrusted('memory', content, maxLen) : content
}

/** The owner's words as saved: quoted third-party text is left out. */
export function ownerWords(text: string): string {
  // A wrapper closes only with its own label and id (the backreference); its
  // content has every other block tag defanged, so it cannot close early.
  return text.replace(/<(untrusted-[\w-]+)>[\s\S]*?<\/\1>/g, '[quoted text]')
}

/** True when the owner's message carried quoted or forwarded text. */
export function hasQuoted(text: string): boolean {
  return /<untrusted-[\w-]+>/.test(text)
}

export type { MemoryOrigin }
