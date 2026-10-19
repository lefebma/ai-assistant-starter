/**
 * Owner-facing copy for email alerts. Telegram sends it as plain text, but
 * Teams and Slack render markdown, so anything taken from an email (sender,
 * subject, the model's reason) is neutralised first: markdown and link
 * syntax is escaped, angle brackets become look-alikes (Slack ignores
 * backslash escapes), and http(s):// is defanged so nothing auto-links.
 * An email can never turn into a masked link in an alert.
 */
import type { AlertRow } from './store.js'
import { senderAddress } from './rules.js'

export const ALERT_BUTTONS = ['Useful', 'Not urgent', 'Mute sender', 'Pause alerts']

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Makes email-sourced text inert on every adapter, while staying readable. */
export function neutralise(s: string): string {
  return s
    .replace(/[\\`*_~[\]()]/g, (c) => `\\${c}`)
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\b(h)tt(ps?):\/\//gi, (_m, h: string, p: string) => `${h}xx${p}://`)
}

function senderLine(from: string): string {
  const address = senderAddress(from)
  const lt = from.indexOf('<')
  const name = lt > 0 ? oneLine(from.slice(0, lt).trim().replace(/^["']+|["']+$/g, '')) : ''
  return name && name.toLowerCase() !== address
    ? `${neutralise(name)} (${neutralise(address)})`
    : neutralise(address)
}

function plural(n: number): string {
  return n === 1 ? '1 critical email' : `${n} critical emails`
}

/** Three lines: sender name and address; subject; reason. */
export function formatAlert(a: AlertRow): string {
  const subject = oneLine(a.subject)
  return [senderLine(a.sender), subject ? neutralise(subject) : '(no subject)', neutralise(oneLine(a.reason))].join(
    '\n'
  )
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
