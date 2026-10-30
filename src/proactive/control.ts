/**
 * Owner control for proactive messages: the commands the proactive skill
 * runs through scripts/proactive.ts. Every reply is plain owner-facing text.
 * Card #262 adds per-kind switches and quiet hours on top of these.
 */
import { getSettings, recentDecisions, saveSettings, type DecisionRow } from './store.js'
import type { CalendarSource } from './calendar.js'

export interface ControlDeps {
  calendars: () => Promise<CalendarSource[]>
  now: () => Date
  tz: string
}

const MIN_LEAD = 5
const MAX_LEAD = 180
const DEFAULT_LOG = 10
const MAX_LOG = 30

const HELP = 'Commands: on, off, status, log [count], lead <minutes, 5 to 180>.'

function stamp(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

function logLine(r: DecisionRow, tz: string): string {
  const what =
    r.status === 'sent'
      ? `briefing sent${r.reason ? ` (${r.reason})` : ''}`
      : r.status === 'quiet'
        ? `no message: ${r.reason}`
        : r.status === 'pending'
          ? 'briefing waiting to send'
          : 'briefing could not be sent'
  return `${stamp(r.startMs, tz)}  ${r.title}: ${what}`
}

async function accounts(deps: ControlDeps): Promise<string[]> {
  try {
    return (await deps.calendars()).map((c) => `${c.id} (${c.provider === 'google' ? 'Google' : 'Outlook'})`)
  } catch {
    return []
  }
}

export async function runControl(argv: string[], deps: ControlDeps): Promise<string> {
  const [cmd = 'status', arg] = argv.map((a) => a.trim())
  const s = getSettings()
  switch (cmd.toLowerCase()) {
    case 'on': {
      const list = await accounts(deps)
      if (list.length === 0) {
        return 'No calendar is connected, so there is nothing to read yet. Connect Google or Outlook first, then turn this on.'
      }
      saveSettings({ ...s, enabled: true })
      return [
        `Meeting briefings are on. About ${s.leadMinutes} minutes before a meeting with other people, I check recent mail with the attendees and message you only when something needs your attention.`,
        `I read the calendar and mail of: ${list.join(', ')}. I never reply, send or change anything on my own.`,
      ].join('\n')
    }
    case 'off':
      saveSettings({ ...s, enabled: false })
      return 'Meeting briefings are off.'
    case 'lead': {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < MIN_LEAD || n > MAX_LEAD) {
        return `Give the lead time in minutes, from ${MIN_LEAD} to ${MAX_LEAD}.`
      }
      saveSettings({ ...s, leadMinutes: n })
      return `Briefings now arrive about ${n} minutes before a meeting.`
    }
    case 'log': {
      const n = arg ? Number(arg) : DEFAULT_LOG
      const count = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LOG) : DEFAULT_LOG
      const rows = recentDecisions(count)
      if (rows.length === 0) return 'Nothing decided yet.'
      return rows.map((r) => logLine(r, deps.tz)).join('\n')
    }
    case 'status': {
      if (!s.enabled) return 'Meeting briefings are off.'
      const list = await accounts(deps)
      const since = deps.now().getTime() - 7 * 86_400_000
      const week = recentDecisions(500).filter((r) => r.createdAt >= since)
      const sent = week.filter((r) => r.status === 'sent').length
      const quiet = week.filter((r) => r.status === 'quiet').length
      return [
        `Meeting briefings are on, about ${s.leadMinutes} minutes before each meeting.`,
        list.length ? `Calendars: ${list.join(', ')}.` : 'No calendar is reachable right now.',
        `Last 7 days: ${sent} ${sent === 1 ? 'briefing' : 'briefings'} sent, ${quiet} ${quiet === 1 ? 'meeting' : 'meetings'} with nothing worth a message.`,
      ].join('\n')
    }
    default:
      return HELP
  }
}
