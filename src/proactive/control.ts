/**
 * Owner control for proactive messages: the commands the proactive skill
 * runs through scripts/proactive.ts. Every reply is plain owner-facing text.
 * Settings change through applyChange (settings.ts), the same path the web
 * app's settings use.
 */
import { recentDecisions, type DecisionRow } from './store.js'
import {
  KINDS,
  LIMITS,
  applyChange,
  getQuietHours,
  getSettings,
  kindName,
  quietText,
  type MessageKind,
  type QuietHours,
} from './settings.js'
import type { CalendarSource } from './calendar.js'

export interface ControlDeps {
  calendars: () => Promise<CalendarSource[]>
  now: () => Date
  tz: string
}

const DEFAULT_LOG = 10
const MAX_LOG = 30

const HELP = `Commands: on [kind], off [kind], status, log [count], lead <minutes, ${LIMITS.leadMinutes.min} to ${LIMITS.leadMinutes.max}>, quiet <start> <end>, quiet off. Kinds: ${KINDS.filter((k) => k.available)
  .map((k) => k.id)
  .join(', ')}.`

const KIND_WORDS: Record<string, MessageKind> = {
  briefing: 'briefing',
  briefings: 'briefing',
  meetings: 'briefing',
  travel: 'travel',
  timing: 'timing',
}

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

/** `on`/`off` with no kind means every kind this version runs. */
function kindsFor(arg: string | undefined): MessageKind[] | string {
  if (!arg) return KINDS.filter((k) => k.available).map((k) => k.id)
  const k = KIND_WORDS[arg.toLowerCase()]
  return k ? [k] : `I don't know "${arg}". ${HELP}`
}

export async function runControl(argv: string[], deps: ControlDeps): Promise<string> {
  const [cmd = 'status', ...rest] = argv.map((a) => a.trim()).filter(Boolean)
  const arg = rest[0]
  const s = getSettings()
  switch (cmd.toLowerCase()) {
    case 'on':
    case 'off': {
      const kinds = kindsFor(arg)
      if (typeof kinds === 'string') return kinds
      const want = cmd.toLowerCase() === 'on'
      const on = Object.fromEntries(kinds.map((k) => [k, want])) as Partial<Record<MessageKind, boolean>>
      const r = applyChange(s, { on }, want ? await accounts(deps) : [])
      if (r.message !== 'Nothing changed.') return r.message
      return kinds.map((k) => `${kindName(k)} are already ${want ? 'on' : 'off'}.`).join('\n')
    }
    case 'lead': {
      const r = applyChange(s, { leadMinutes: Number(arg) }, [])
      return r.message === 'Nothing changed.' ? `Briefings already arrive about ${s.briefing.leadMinutes} minutes before a meeting.` : r.message
    }
    case 'quiet': {
      let q: QuietHours | null
      if (arg?.toLowerCase() === 'off' || arg?.toLowerCase() === 'none') q = null
      else if (rest.length === 2) q = { start: rest[0]!, end: rest[1]! }
      else return 'Quiet hours need a start and an end, like 22:00 07:00, or "off".'
      const r = applyChange(s, { quietHours: q }, [])
      return r.message === 'Nothing changed.' ? quietText(getQuietHours()) : r.message
    }
    case 'log': {
      const n = arg ? Number(arg) : DEFAULT_LOG
      const count = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LOG) : DEFAULT_LOG
      const rows = recentDecisions(count)
      if (rows.length === 0) return 'Nothing decided yet.'
      return rows.map((r) => logLine(r, deps.tz)).join('\n')
    }
    case 'status': {
      const kinds = KINDS.filter((k) => k.available)
      const lines = kinds.map((k) =>
        k.id === 'briefing' && s.briefing.on
          ? `${kindName(k.id)} are on, about ${s.briefing.leadMinutes} minutes before each meeting.`
          : `${kindName(k.id)} are ${s[k.id].on ? 'on' : 'off'}.`
      )
      if (!kinds.some((k) => s[k.id].on)) return lines.join('\n')
      const list = await accounts(deps)
      const since = deps.now().getTime() - 7 * 86_400_000
      const week = recentDecisions(500).filter((r) => r.createdAt >= since)
      const sent = week.filter((r) => r.status === 'sent').length
      const quiet = week.filter((r) => r.status === 'quiet').length
      lines.push(
        quietText(getQuietHours()),
        list.length ? `Calendars: ${list.join(', ')}.` : 'No calendar is reachable right now.',
        `Last 7 days: ${sent} ${sent === 1 ? 'briefing' : 'briefings'} sent, ${quiet} ${quiet === 1 ? 'meeting' : 'meetings'} with nothing worth a message.`
      )
      return lines.join('\n')
    }
    default:
      return HELP
  }
}
