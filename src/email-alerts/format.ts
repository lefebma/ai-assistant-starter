/**
 * Owner-facing copy for email alerts. Anything taken from an email (sender,
 * subject, the model's reason) is neutralised first, by the adapter's mode:
 *
 * - `markdown` (Teams, Slack): markdown and link syntax is escaped, angle
 *   brackets become look-alikes (Slack ignores backslash escapes), and
 *   http(s):// is defanged so nothing auto-links.
 * - `plain` (Telegram, sent without a parse mode): no backslash escapes,
 *   which would show up literally; only the angle-bracket swap and the URL
 *   defang.
 *
 * Either way an email can never turn into a masked link in an alert.
 */
import type { AlertRow } from './store.js'
import { senderAddress } from './rules.js'

export const ALERT_BUTTONS = ['Useful', 'Not urgent', 'Mute sender', 'Pause alerts']

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** How the adapter renders text: `plain` shows it as is, `markdown` parses it. */
export type FormatMode = 'plain' | 'markdown'

/** Makes email-sourced text inert on the given adapter, while staying readable. */
export function neutralise(s: string, mode: FormatMode = 'markdown'): string {
  const escaped = mode === 'markdown' ? s.replace(/[\\`*_~[\]()]/g, (c) => `\\${c}`) : s
  return escaped
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\b(h)tt(ps?):\/\//gi, (_m, h: string, p: string) => `${h}xx${p}://`)
}

function senderLine(from: string, mode: FormatMode): string {
  const address = senderAddress(from)
  const lt = from.indexOf('<')
  const name = lt > 0 ? oneLine(from.slice(0, lt).trim().replace(/^["']+|["']+$/g, '')) : ''
  return name && name.toLowerCase() !== address
    ? `${neutralise(name, mode)} (${neutralise(address, mode)})`
    : neutralise(address, mode)
}

function plural(n: number): string {
  return n === 1 ? '1 critical email' : `${n} critical emails`
}

/** Three lines: sender name and address; subject; reason. */
export function formatAlert(a: AlertRow, mode: FormatMode = 'markdown'): string {
  const subject = oneLine(a.subject)
  return [
    senderLine(a.sender, mode),
    subject ? neutralise(subject, mode) : '(no subject)',
    neutralise(oneLine(a.reason), mode),
  ].join('\n')
}

export function formatOverflow(n: number): string {
  return `…and ${n} more ${n === 1 ? 'critical email' : 'critical emails'} in your inbox.`
}

export function pauseEndHeader(n: number): string {
  return n > 0
    ? `Email alerts are back on. ${plural(n)} came in while paused.`
    : 'Email alerts are back on. Nothing critical came in while paused.'
}

export function quietEndHeader(n: number): string {
  return `While you were offline: ${plural(n)}.`
}
