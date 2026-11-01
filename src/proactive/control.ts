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
  modeName,
  quietText,
  type MessageKind,
  type QuietHours,
} from './settings.js'
import type { CalendarSource } from './calendar.js'

export interface ControlDeps {
  calendars: () => Promise<CalendarSource[]>
  now: () => Date
  tz: string
  /** A maps source is set up (card #260). Without it travel messages give the place only. */
  mapsReady?: () => boolean
}

const DEFAULT_LOG = 10
const MAX_LOG = 30

const HELP = `Commands: on [kind], off [kind], status, log [count], lead <minutes, ${LIMITS.leadMinutes.min} to ${LIMITS.leadMinutes.max}>, buffer <minutes, ${LIMITS.bufferMinutes.min} to ${LIMITS.bufferMinutes.max}>, mode drive|transit|walk, from <starting address>, from off, ahead <hours, ${LIMITS.aheadHours.min} to ${LIMITS.aheadHours.max}>, quiet <start> <end>, quiet off. Kinds: ${KINDS.filter((k) => k.available)
  .map((k) => k.id)
  .join(', ')}.`

const KIND_WORDS: Record<string, MessageKind> = {
  briefing: 'briefing',
  briefings: 'briefing',
  meetings: 'briefing',
  travel: 'travel',
  timing: 'timing',
  warnings: 'timing',
  problems: 'timing',
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
  const name = r.kind === 'travel' ? 'travel message' : r.kind === 'timing' ? 'timing warning' : 'briefing'
  const what =
    r.status === 'sent'
      ? `${name} sent${r.reason ? ` (${r.reason})` : ''}`
      : r.status === 'quiet'
        ? `no ${name}: ${r.reason}`
        : r.status === 'pending'
          ? `${name} waiting to send`
          : `${name} could not be sent`
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
  const mapsReady = deps.mapsReady?.() ?? false
  const same = (r: { message: string }, already: string): string => (r.message === 'Nothing changed.' ? already : r.message)
  switch (cmd.toLowerCase()) {
    case 'on':
    case 'off': {
      const kinds = kindsFor(arg)
      if (typeof kinds === 'string') return kinds
      const want = cmd.toLowerCase() === 'on'
      const on = Object.fromEntries(kinds.map((k) => [k, want])) as Partial<Record<MessageKind, boolean>>
      const r = applyChange(s, { on }, { calendars: want ? await accounts(deps) : [], mapsReady })
      if (r.message !== 'Nothing changed.') return r.message
      return kinds.map((k) => `${kindName(k)} are already ${want ? 'on' : 'off'}.`).join('\n')
    }
    case 'lead': {
      const r = applyChange(s, { leadMinutes: Number(arg) }, [])
      return r.message === 'Nothing changed.' ? `Briefings already arrive about ${s.briefing.leadMinutes} minutes before a meeting.` : r.message
    }
    case 'buffer':
      return same(applyChange(s, { bufferMinutes: Number(arg) }, { calendars: [], mapsReady }), `Travel messages already arrive about ${s.travel.bufferMinutes} minutes before you need to leave.`)
    case 'mode':
      if (!arg) return `Travel times are worked out for ${modeName(s.travel.mode)}. Say mode drive, transit or walk to change it.`
      return same(applyChange(s, { mode: arg }, { calendars: [], mapsReady }), `Travel times are already worked out for ${modeName(s.travel.mode)}.`)
    case 'from': {
      if (rest.length === 0) return s.travel.origin ? `Starting address: ${s.travel.origin}.` : 'No starting address is set. Say from and the address, like from 100 King St W, Toronto.'
      const off = rest.length === 1 && ['off', 'none', 'clear'].includes(arg!.toLowerCase())
      return same(applyChange(s, { origin: off ? '' : rest.join(' ') }, { calendars: [], mapsReady }), off ? 'No starting address is set.' : `That is already your starting address.`)
    }
    case 'ahead':
      return same(applyChange(s, { aheadHours: Number(arg) }, { calendars: [], mapsReady }), `Timing warnings already look ${s.timing.aheadHours} hours ahead.`)
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
      const lines = kinds.map((k) => {
        if (k.id === 'briefing' && s.briefing.on) return `${kindName(k.id)} are on, about ${s.briefing.leadMinutes} minutes before each meeting.`
        if (k.id === 'travel' && s.travel.on) {
          const from = s.travel.origin ? `from ${s.travel.origin}` : 'with no starting address set'
          const times = mapsReady ? `travel times for ${modeName(s.travel.mode)} ${from}` : 'the place only, since travel times are not set up'
          return `${kindName(k.id)} are on, about ${s.travel.bufferMinutes} minutes before you need to leave, with ${times}.`
        }
        if (k.id === 'timing' && s.timing.on) return `${kindName(k.id)} are on, looking ${s.timing.aheadHours} hours ahead.`
        return `${kindName(k.id)} are ${s[k.id].on ? 'on' : 'off'}.`
      })
      if (!kinds.some((k) => s[k.id].on)) return lines.join('\n')
      const list = await accounts(deps)
      const since = deps.now().getTime() - 7 * 86_400_000
      const week = recentDecisions(500).filter((r) => r.createdAt >= since)
      const sent = week.filter((r) => r.status === 'sent' && r.kind === 'briefing').length
      const trips = week.filter((r) => r.status === 'sent' && r.kind === 'travel').length
      const quiet = week.filter((r) => r.status === 'quiet' && r.kind === 'briefing').length
      const warnings = week.filter((r) => r.status === 'sent' && r.kind === 'timing').length
      lines.push(
        quietText(getQuietHours()),
        list.length ? `Calendars: ${list.join(', ')}.` : 'No calendar is reachable right now.',
        `Last 7 days: ${sent} ${sent === 1 ? 'briefing' : 'briefings'} sent, ${quiet} ${quiet === 1 ? 'meeting' : 'meetings'} with nothing worth a message${s.travel.on ? `, ${trips} travel ${trips === 1 ? 'message' : 'messages'}` : ''}${s.timing.on ? `, ${warnings} timing ${warnings === 1 ? 'warning' : 'warnings'}` : ''}.`
      )
      return lines.join('\n')
    }
    default:
      return HELP
  }
}
