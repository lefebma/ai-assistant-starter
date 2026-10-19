import { localDay as zonedDay, nextDay, offsetMinutes } from '../ms/time.js'

export interface MailHeaders {
  from: string
  listUnsubscribe?: string
  listId?: string
  precedence?: string
  autoSubmitted?: string
  returnPath?: string
}

export type PreDecision = 'mute' | 'vip' | 'automated' | 'triage'
export type PauseDuration = '1h' | 'tomorrow' | '1d' | '1w' | 'off'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|alerts?|news(letter)?|billing|receipts?|support|info|marketing)\b/

/** Lowercased address from `"Name <a@b>"` or a bare address. */
export function senderAddress(from: string): string {
  const m = /<([^>]*)>/.exec(from)
  return (m ? m[1]! : from).trim().toLowerCase()
}

/** An entry with "@" is an exact address; a bare domain covers its subdomains too. */
export function matchesList(address: string, entries: string[]): boolean {
  const addr = address.trim().toLowerCase()
  const domain = addr.slice(addr.lastIndexOf('@') + 1)
  for (const raw of entries) {
    const e = raw.trim().toLowerCase()
    if (!e) continue
    if (e.includes('@')) {
      if (addr === e) return true
    } else if (domain === e || domain.endsWith(`.${e}`)) {
      return true
    }
  }
  return false
}

export function isAutomated(h: MailHeaders): boolean {
  if (h.listUnsubscribe || h.listId) return true
  const auto = h.autoSubmitted?.trim().toLowerCase()
  if (auto && auto !== 'no') return true
  const prec = h.precedence?.trim().toLowerCase()
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true
  const addr = senderAddress(h.from)
  return AUTOMATED_LOCAL.test(addr.slice(0, addr.lastIndexOf('@') >= 0 ? addr.lastIndexOf('@') : addr.length))
}

/** Mute beats VIP, VIP beats automated. */
export function preDecide(h: MailHeaders, vip: string[], mute: string[]): PreDecision {
  const addr = senderAddress(h.from)
  if (matchesList(addr, mute)) return 'mute'
  if (matchesList(addr, vip)) return 'vip'
  if (isAutomated(h)) return 'automated'
  return 'triage'
}

function hm(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function minutesOfDay(now: Date, tz: string): number {
  const local = new Date(now.getTime() + offsetMinutes(now, tz) * 60_000)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

/** Start inclusive, end exclusive; a window with start after end wraps midnight. */
export function inQuietHours(now: Date, tz: string, start: string, end: string): boolean {
  const s = hm(start)
  const e = hm(end)
  if (s === e) return false
  const m = minutesOfDay(now, tz)
  return s < e ? m >= s && m < e : m >= s || m < e
}

/** Epoch ms of a local wall-clock day + HH:MM, settled across a DST shift. */
function localToEpoch(day: string, time: string, tz: string): number {
  const [y, mo, d] = day.split('-').map(Number)
  const utc = Date.UTC(y!, mo! - 1, d!, 0, hm(time))
  let t = utc - offsetMinutes(new Date(utc), tz) * 60_000
  const off = offsetMinutes(new Date(t), tz)
  t = utc - off * 60_000
  return t
}

/** The next quiet-hours end strictly after now. */
export function nextQuietEnd(now: Date, tz: string, end: string): number {
  const today = localToEpoch(zonedDay(now, tz), end, tz)
  if (today > now.getTime()) return today
  return localToEpoch(nextDay(zonedDay(now, tz)), end, tz)
}

/** `off` is null, meaning indefinite. */
export function pauseUntil(d: PauseDuration, now: Date, tz: string, quietEnd: string): number | null {
  switch (d) {
    case '1h':
      return now.getTime() + HOUR
    case '1d':
      return now.getTime() + DAY
    case '1w':
      return now.getTime() + 7 * DAY
    case 'tomorrow':
      return nextQuietEnd(now, tz, quietEnd)
    case 'off':
      return null
  }
}

/** YYYY-MM-DD where the owner lives. */
export function localDay(now: Date, tz: string): string {
  return zonedDay(now, tz)
}
