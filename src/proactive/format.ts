/**
 * The pre-meeting briefing as the owner reads it. Short, specific, no
 * explanation of how it was made. At most MAX_SHOWN threads to read; the
 * rest become one "N more" line.
 */
import type { UpcomingEvent } from './calendar.js'
import type { Decision } from './decide.js'

export type FormatMode = 'plain' | 'markdown'

export const MAX_SHOWN = 5
const MAX_NAMES = 4

function time(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(ms)
  )
}

function who(event: UpcomingEvent): string {
  const names = event.attendees.map((a) => a.name || a.email)
  if (names.length === 0) return ''
  const shown = names.slice(0, MAX_NAMES).join(', ')
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown
}

/** Markdown would read a stray bracket or asterisk in a subject as markup. */
function md(s: string): string {
  return s.replace(/([\\`*_[\]()#])/g, '\\$1')
}

function threadName(subject: string, link: string, mode: FormatMode): string {
  if (mode === 'markdown') return link ? `[${md(subject)}](${link})` : md(subject)
  return subject
}

export function formatBriefing(event: UpcomingEvent, d: Decision, tz: string, mode: FormatMode = 'markdown'): string {
  const esc = mode === 'markdown' ? md : (s: string) => s
  const people = who(event)
  const lines = [`Before ${esc(event.title)} at ${time(event.startMs, tz)}${people ? ` (${esc(people)})` : ''}:`]
  const shown = d.picks.slice(0, MAX_SHOWN)
  if (shown.length > 0) {
    lines.push('', 'Worth reading first:')
    shown.forEach((p, i) => {
      lines.push(`${i + 1}. ${threadName(p.thread.subject, p.thread.link, mode)}: ${esc(p.why)}`)
      if (mode === 'plain' && p.thread.link) lines.push(`   ${p.thread.link}`)
    })
  }
  if (d.owed.length > 0) {
    lines.push('', 'You owe:')
    for (const o of d.owed.slice(0, MAX_SHOWN)) lines.push(`- ${esc(o.what)} (${esc(o.thread.subject)})`)
  }
  const more = d.picks.length - shown.length
  if (more > 0) lines.push('', `${more} more related ${more === 1 ? 'thread' : 'threads'}.`)
  return lines.join('\n')
}
