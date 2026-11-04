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
import { wrapUntrusted } from '../prompt-safety.js'

/** Evidence types that mean a turn's tools read text the owner did not write. */
export const OUTSIDE_READS = ['mail.read', 'web.read', 'source.read'] as const

/** The origin of an assistant reply, from what the turn's tools read. */
export function replyOrigin(reads: readonly string[] | undefined): 'assistant' | 'untrusted' {
  return reads?.some((r) => (OUTSIDE_READS as readonly string[]).includes(r)) ? 'untrusted' : 'assistant'
}

/** True when a recalled memory must reach the model inside an untrusted wrapper. */
export function isUntrusted(m: Pick<Memory, 'origin' | 'content'>): boolean {
  if (m.origin === 'untrusted') return true
  // Written before provenance: only the owner's own words are known to be safe.
  return m.origin === 'legacy' && !m.content.startsWith('User said:')
}

const BLOCK_TAG = /<\s*\/?\s*(memory-context|workspace-context|decision-ledger|untrusted-[\w-]*)\b[^>]*>/gi

/** Neutralise any context-block tag inside stored text (card #235, defect 12). */
export function defang(text: string): string {
  return text.replace(BLOCK_TAG, '[tag]')
}

/** The line a memory contributes to the memory block. */
export function recallLine(m: Pick<Memory, 'origin' | 'content'>, maxLen = 400): string {
  const content = defang(m.content)
  return isUntrusted(m) ? wrapUntrusted('memory', content, maxLen) : content
}

/** The owner's words as saved: quoted third-party text is left out. */
export function ownerWords(text: string): string {
  return text.replace(/<untrusted-[\w-]+>[\s\S]*?<\/untrusted-[\w-]+>/g, '[quoted text]')
}

export type { MemoryOrigin }
