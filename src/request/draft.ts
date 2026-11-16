/**
 * /request: a customer asks for a feature or capability from their chat
 * (card #240). Built on the /support flow (card #95): the same draft, confirm,
 * send path, but with no diagnostics. Only the customer's name, the box's name
 * and the version go with the request. No logs, no skills list, no history.
 *
 * Pure: no I/O, so the whole shape is testable.
 */
import { randomBytes } from 'node:crypto'

export interface RequestDraft {
  to: string
  subject: string
  body: string
  /** Short reference the customer can quote later, e.g. REQ-7K3F. */
  ref: string
  /** The tidied request, as shown in the preview. */
  summary: string
}

export interface RequestSender {
  ownerName: string
  /** The name the owner calls the assistant, e.g. Nami. Empty when none is set. */
  assistantName: string
  /** The box's address, so a request can be traced to the install that sent it. */
  boxName: string
  version: string
}

/** "Nami (nami.gethavn.ai)", or just the address when the assistant has no name. */
function assistantLabel(sender: RequestSender): string {
  return sender.assistantName ? `${sender.assistantName} (${sender.boxName})` : sender.boxName
}

/** Longest request we accept. A wish list longer than this belongs in an email. */
export const MAX_REQUEST_CHARS = 2000

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** REQ- plus four characters with no 0/O or 1/I/L, so it reads back over the phone. */
export function newRequestRef(rand: (n: number) => Buffer = randomBytes): string {
  const bytes = rand(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length]
  return `REQ-${s}`
}

/** The prompt that turns the customer's words into three short lines. */
export function tidyPrompt(raw: string): string {
  return [
    'A customer of an AI assistant wrote the request below for a feature or capability they want.',
    'Rewrite it as exactly three short lines, in the language they wrote in:',
    'What: <what they want the assistant to do>',
    'Why: <what it would help them with>',
    'How often: <how often they would use it>',
    'Use only what they said. Where they did not say, write "Not said". Do not add ideas, advice or any other text.',
    '',
    '<request>',
    raw,
    '</request>',
  ].join('\n')
}

const LINE = /^(what|why|how often)\s*:\s*(.+)$/i

/**
 * The three lines from the model's answer, or the customer's own words when
 * the answer is not that shape (a refusal, extra chatter, an empty reply).
 */
export function parseTidied(output: string, raw: string): string {
  const found = new Map<string, string>()
  for (const line of output.split('\n')) {
    const m = LINE.exec(line.trim())
    if (m && !found.has(m[1]!.toLowerCase())) found.set(m[1]!.toLowerCase(), m[2]!.trim())
  }
  if (!found.has('what')) return `What: ${raw.trim()}`
  return [
    `What: ${found.get('what')}`,
    `Why: ${found.get('why') ?? 'Not said'}`,
    `How often: ${found.get('how often') ?? 'Not said'}`,
  ].join('\n')
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function buildRequestDraft(summary: string, sender: RequestSender, to: string, ref: string): RequestDraft {
  const what = /^What:\s*(.*)$/m.exec(summary)?.[1] ?? summary
  return {
    to,
    ref,
    summary,
    subject: `Feature request ${ref}: ${oneLine(what, 60)}`,
    body: [
      `Feature request ${ref}`,
      '',
      summary.trim(),
      '',
      '--- Sent with it ---',
      `Customer: ${sender.ownerName || 'not set'}`,
      `Assistant: ${assistantLabel(sender)}`,
      `Version: ${sender.version}`,
      '',
    ].join('\n'),
  }
}

/**
 * What the customer sees before anything is sent. Every part is its own
 * paragraph and the request lines are a list: Teams renders replies as
 * Markdown, where a single line break collapses and the lines run together.
 */
export function formatRequestPreview(draft: RequestDraft, sender: RequestSender): string {
  const lines = draft.summary
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
  const name = sender.assistantName ? `this assistant's name (${sender.assistantName}), its address (${sender.boxName})` : `this assistant's address (${sender.boxName})`
  return [
    'Your request:',
    lines.join('\n'),
    `Sent with it: your name (${sender.ownerName || 'not set'}), ${name} and its version (${sender.version}). Nothing else.`,
    'Nothing has been sent yet.',
  ].join('\n\n')
}
