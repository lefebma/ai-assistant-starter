/**
 * Owner control for email alerts: the commands the email-alerts skill runs
 * through scripts/email-alerts.ts. Every reply is plain owner-facing text.
 *
 * Replay re-reads past mail and re-runs triage outside the daily cap and the
 * at-most-once rule. It never sends, never marks mail as seen and never
 * records an alert.
 */
import {
  getSettings,
  listAdd,
  listAll,
  listRemove,
  saveSettings,
  stats,
  triageCount,
} from './store.js'
import { localDay, preDecide, senderAddress, type PauseDuration } from './rules.js'
import { formatWhen, pauseFor } from './buttons.js'
import { DAILY_TRIAGE_CAP, triage, type TriageInput, type TriageOutcome } from './triage.js'
import type { Mailbox, NewMail } from './sources.js'

export interface ControlDeps {
  boxes: () => Promise<{ boxes: Mailbox[]; broken: { id: string; why: string }[] }>
  triage: (i: TriageInput) => Promise<TriageOutcome>
  now: () => Date
  tz: string
}

const DAY = 86_400_000
const MAX_PAUSE_MS = 30 * DAY
const MAX_REPLAY_DAYS = 14
const MAX_REPLAY_LINES = 30
/** Model reads per replay, and how many run at once. */
const MAX_REPLAY_READS = 60
const REPLAY_CONCURRENCY = 4
const VIP_REASON = 'From a VIP'
const DURATIONS: PauseDuration[] = ['1h', 'tomorrow', '1d', '1w', 'off']
// A full date and time with its offset, so a box on UTC reads it as meant.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ADDRESS = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

const HELP = [
  'Commands: on, off, status,',
  'pause 1h|tomorrow|1d|1w|off, pause until <ISO time>, resume,',
  'vip add|remove|list <address or domain>, mute add|remove|list <address or domain>,',
  'quiet <HH:MM> <HH:MM>, replay <days, 1 to 14>.',
].join('\n')

/** Triage for replay: the same model read, outside the daily cap. */
export function replayTriage(
  run: (prompt: string) => Promise<string | null>,
  now: () => Date,
  tz: string
): (i: TriageInput) => Promise<TriageOutcome> {
  return (i) => triage(i, { run, day: localDay(now(), tz), countCap: false })
}

/** `@acme.com` and `*@acme.com` become `acme.com`; everything lowercase. */
function normaliseEntry(raw: string): string {
  let e = raw.trim().toLowerCase()
  if (e.startsWith('*@')) e = e.slice(2)
  else if (e.startsWith('@')) e = e.slice(1)
  return e
}

function pauseActive(nowMs: number): boolean {
  const s = getSettings()
  return s.pauseIndefinite || (s.pauseUntil !== null && nowMs < s.pauseUntil)
}

function pauseUntilIso(arg: string | undefined, deps: ControlDeps): string {
  const now = deps.now()
  const at = arg && ISO.test(arg) ? Date.parse(arg) : NaN
  if (!arg || Number.isNaN(at)) return "I couldn't read that time."
  if (at <= now.getTime()) return 'That time has already passed.'
  if (at - now.getTime() > MAX_PAUSE_MS) return 'I can pause email alerts for up to 30 days.'
  saveSettings({
    ...getSettings(),
    pauseUntil: at,
    pauseIndefinite: false,
    pauseStartedAt: now.getTime(),
  })
  return `Email alerts paused until ${formatWhen(new Date(at), now, deps.tz)}.`
}

function pause(args: string[], deps: ControlDeps): string {
  const [first, second] = args
  if (first === 'until') return pauseUntilIso(second, deps)
  if (first && (DURATIONS as string[]).includes(first) && args.length === 1) {
    return pauseFor(first as PauseDuration, deps.now(), deps.tz)
  }
  return 'I can pause for 1h, tomorrow, 1d, 1w, off, or until a set time.'
}

function resume(deps: ControlDeps): string {
  const nowMs = deps.now().getTime()
  if (!pauseActive(nowMs)) return "Email alerts aren't paused."
  // The next tick ends the pause through its normal path, summary included.
  saveSettings({ ...getSettings(), pauseIndefinite: false, pauseUntil: nowMs })
  return 'Email alerts are back on. Anything critical from the pause comes through in the next few minutes.'
}

function list(kind: 'vip' | 'mute', args: string[]): string {
  const [action, ...rest] = args
  const label = kind === 'vip' ? 'VIPs' : 'Muted'
  if (action === 'list') {
    const entries = listAll(kind)
    if (entries.length === 0) return kind === 'vip' ? 'No VIPs yet.' : 'Nobody is muted.'
    return `${label}: ${entries.join(', ')}`
  }
  if (action !== 'add' && action !== 'remove') return `Try ${kind} add, ${kind} remove or ${kind} list.`
  const entry = normaliseEntry(rest.join(' '))
  if (!ADDRESS.test(entry) && !DOMAIN.test(entry)) {
    return "That doesn't look like an email address or a domain."
  }
  if (action === 'add') {
    // The newest instruction for the same entry wins over the other list.
    listRemove(kind === 'vip' ? 'mute' : 'vip', entry)
    listAdd(kind, entry)
    return kind === 'vip' ? `Added ${entry} to your VIPs.` : `Muted ${entry}.`
  }
  if (!listRemove(kind, entry)) {
    return kind === 'vip' ? `${entry} isn't on your VIP list.` : `${entry} isn't muted.`
  }
  return kind === 'vip' ? `Removed ${entry} from your VIPs.` : `Unmuted ${entry}.`
}

function quiet(args: string[]): string {
  const [start, end] = args
  if (args.length !== 2 || !start || !end || !HHMM.test(start) || !HHMM.test(end)) {
    return 'Quiet hours need a start and an end, like 22:00 07:00.'
  }
  saveSettings({ ...getSettings(), quietStart: start, quietEnd: end })
  return start === end ? 'Quiet hours are off.' : `Quiet hours are now ${start} to ${end}.`
}

async function status(deps: ControlDeps): Promise<string> {
  const now = deps.now()
  const s = getSettings()
  const lines: string[] = [s.enabled ? 'Email alerts are on.' : 'Email alerts are off.']
  if (s.pauseIndefinite) lines.push('Paused until you turn them back on.')
  else if (s.pauseUntil !== null && now.getTime() < s.pauseUntil) {
    lines.push(`Paused until ${formatWhen(new Date(s.pauseUntil), now, deps.tz)}.`)
  }
  lines.push(s.quietStart === s.quietEnd ? 'Quiet hours: none.' : `Quiet hours: ${s.quietStart} to ${s.quietEnd}.`)
  lines.push(`VIPs: ${listAll('vip').length}. Muted: ${listAll('mute').length}.`)
  const week = stats(now.getTime() - 7 * DAY)
  lines.push(`Last 7 days: ${week.sent} alerts, ${week.useful} marked useful, ${week.notUrgent} not urgent`)
  if (triageCount(localDay(now, deps.tz)) >= DAILY_TRIAGE_CAP) {
    lines.push('Daily limit reached today, only VIP alerts until tomorrow.')
  }
  try {
    const { boxes, broken } = await deps.boxes()
    if (boxes.length === 0 && broken.length === 0) lines.push('No Gmail or Outlook mailbox is connected.')
    for (const b of broken) lines.push(b.why)
  } catch {
    lines.push("I couldn't check the mailboxes just now.")
  }
  return lines.join('\n')
}

function replayWhen(ms: number, tz: string): string {
  const d = new Date(ms)
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d)
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .replace(/\s?(AM|PM)$/i, (_m, ap: string) => ` ${ap.toLowerCase()}`)
  return `${date} ${time}`
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function replay(args: string[], deps: ControlDeps): Promise<string> {
  const raw = args[0]
  const days = raw && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (args.length !== 1 || !Number.isInteger(days) || days < 1) return 'Replay needs a number of days, from 1 to 14.'
  if (days > MAX_REPLAY_DAYS) return 'Replay can look back 14 days at most.'

  const sinceMs = deps.now().getTime() - days * DAY
  const vip = listAll('vip')
  const mute = listAll('mute')
  const { boxes } = await deps.boxes()

  // Everything in range, newest first, each email once.
  const seen = new Set<string>()
  const queue: { box: Mailbox; mail: NewMail }[] = []
  for (const box of boxes) {
    let mails: NewMail[]
    try {
      mails = await box.list(sinceMs)
    } catch {
      continue
    }
    for (const m of mails) queue.push({ box, mail: m })
  }
  queue.sort((a, b) => b.mail.receivedAt - a.mail.receivedAt)
  const unique = queue.filter(({ box, mail: m }) => {
    const keys = [`${box.id}\n${m.msgId}`, ...(m.rfcMessageId ? [`rfc\n${m.rfcMessageId}`] : [])]
    if (keys.some((k) => seen.has(k))) return false
    for (const k of keys) seen.add(k)
    return true
  })

  // A small pool of model reads, stopping once the budget is spent. Items
  // are taken in order and the budget is checked as each is taken, so every
  // email before the stopping point was examined and none after it was.
  const hits: { at: number; line: string }[] = []
  let next = 0
  let reads = 0
  let stoppedAt: number | null = null
  const worker = async (): Promise<void> => {
    while (stoppedAt === null && next < unique.length) {
      const idx = next++
      const { box, mail: m } = unique[idx]!
      const decision = preDecide(m.headers, vip, mute)
      if (decision === 'mute' || decision === 'automated') continue
      let reason: string
      if (decision === 'vip') reason = VIP_REASON
      else {
        if (reads >= MAX_REPLAY_READS) {
          stoppedAt = idx
          return
        }
        reads++
        let body: string
        try {
          body = await box.body(m.msgId)
        } catch {
          continue
        }
        const outcome = await deps.triage({ from: m.headers.from, subject: m.subject, body })
        if (outcome.kind !== 'verdict' || !outcome.verdict.critical) continue
        reason = outcome.verdict.reason
      }
      hits.push({
        at: m.receivedAt,
        line: [
          replayWhen(m.receivedAt, deps.tz),
          senderAddress(m.headers.from),
          oneLine(m.subject) || '(no subject)',
          oneLine(reason),
        ].join('  '),
      })
    }
  }
  await Promise.all(Array.from({ length: REPLAY_CONCURRENCY }, () => worker()))

  const tail = stoppedAt === null ? [] : [`Checked the newest ${stoppedAt} emails.`]
  if (hits.length === 0) {
    if (tail.length > 0) return ['Nothing would have alerted.', ...tail].join('\n')
    return `Nothing would have alerted in the last ${days} ${days === 1 ? 'day' : 'days'}.`
  }
  hits.sort((a, b) => b.at - a.at)
  const room = MAX_REPLAY_LINES - tail.length
  const body =
    hits.length <= room
      ? hits.map((h) => h.line)
      : [...hits.slice(0, room - 1).map((h) => h.line), `…and ${hits.length - (room - 1)} more.`]
  return [...body, ...tail].join('\n')
}

export async function runControl(argv: string[], deps: ControlDeps): Promise<string> {
  const [cmd, ...args] = argv.map((a) => a.trim()).filter(Boolean)
  switch (cmd?.toLowerCase()) {
    case 'on':
      saveSettings({ ...getSettings(), enabled: true })
      return 'Email alerts are on.'
    case 'off':
      saveSettings({ ...getSettings(), enabled: false })
      return 'Email alerts are off.'
    case 'pause':
      return pause(args, deps)
    case 'resume':
      return resume(deps)
    case 'vip':
      return list('vip', args)
    case 'mute':
      return list('mute', args)
    case 'quiet':
      return quiet(args)
    case 'status':
      return status(deps)
    case 'replay':
      return replay(args, deps)
    default:
      return HELP
  }
}
