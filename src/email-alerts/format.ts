/**
 * Owner-facing copy for email alerts. Plain text only: adapters send it
 * without a parse mode, so nothing here is escaped or marked up.
 */
import type { AlertRow } from './store.js'
import { senderAddress } from './rules.js'

export const ALERT_BUTTONS = ['Useful', 'Not urgent', 'Mute sender', 'Pause alerts']

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function senderLine(from: string): string {
  const address = senderAddress(from)
  const lt = from.indexOf('<')
  const name = lt > 0 ? oneLine(from.slice(0, lt).trim().replace(/^["']+|["']+$/g, '')) : ''
  return name && name.toLowerCase() !== address ? `${name} (${address})` : address
}

/** Three lines: sender name and address; subject; reason. */
export function formatAlert(a: AlertRow): string {
  return [senderLine(a.sender), oneLine(a.subject) || '(no subject)', oneLine(a.reason)].join('\n')
}

export function formatOverflow(n: number): string {
  return `…and ${n} more critical emails in your inbox.`
}

export function pauseEndHeader(n: number): string {
  return n > 0
    ? `Email alerts are back on. ${n} critical emails came in while paused.`
    : 'Email alerts are back on. Nothing critical came in while paused.'
}

export function quietEndHeader(n: number): string {
  return `While you were offline: ${n} critical emails.`
}
