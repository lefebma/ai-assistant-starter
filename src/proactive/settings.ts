/**
 * The owner's proactive message settings (card #262): each kind of message
 * on or off with its own timing, and the travel details the in-person
 * messages use. Stored in app_state, so they survive updates and restarts.
 * Everything starts off; nothing is sent until the owner turns a kind on, in
 * chat or in the web app.
 *
 * Quiet hours are not stored here. They are the owner's one quiet-hours
 * setting for every message they did not ask for, kept with email alerts
 * (22:00 to 07:00 unless changed; the same start and end means none), so
 * "quiet hours from 10 pm" means the same thing whichever skill hears it.
 *
 * The chat command (control.ts) and the web settings route both change
 * settings through applyChange, so the two cannot drift: same limits, same
 * refusal when no calendar is connected, same replies.
 */
import { getAppState, setAppState } from '../db.js'
import { getSettings as getAlertSettings, saveSettings as saveAlertSettings } from '../email-alerts/store.js'
import { inQuietHours, nextQuietEnd } from '../email-alerts/rules.js'

export type MessageKind = 'briefing' | 'travel' | 'timing'
export type TravelMode = 'drive' | 'transit' | 'walk'

export interface QuietHours {
  /** Local "HH:MM", 24-hour. The window may cross midnight. */
  start: string
  end: string
}

export interface ProactiveSettings {
  briefing: { on: boolean; leadMinutes: number }
  /** In-person meetings (card #260): leave-by message bufferMinutes before the leave-by time. */
  travel: { on: boolean; bufferMinutes: number; mode: TravelMode; origin: string }
  /** Timing problems (card #261): problems in the next aheadHours. */
  timing: { on: boolean; aheadHours: number }
  /** How far ahead the calendar is read. */
  windowHours: number
}

export interface KindInfo {
  id: MessageKind
  label: string
  /** Built and running on this version. Kinds still being built are kept off and hidden. */
  available: boolean
}

export const KINDS: KindInfo[] = [
  { id: 'briefing', label: 'Meeting briefings', available: true },
  { id: 'travel', label: 'Travel messages', available: false },
  { id: 'timing', label: 'Timing problems', available: false },
]

export const LIMITS = {
  leadMinutes: { min: 5, max: 180 },
  bufferMinutes: { min: 0, max: 60 },
  aheadHours: { min: 1, max: 72 },
} as const

export const DEFAULT_LEAD_MINUTES = 30
export const DEFAULT_WINDOW_HOURS = 24
const SETTINGS_KEY = 'proactive.settings'
const TRAVEL_MODES: TravelMode[] = ['drive', 'transit', 'walk']
const MAX_ORIGIN = 200

export function defaultSettings(): ProactiveSettings {
  return {
    briefing: { on: false, leadMinutes: DEFAULT_LEAD_MINUTES },
    travel: { on: false, bufferMinutes: 15, mode: 'drive', origin: '' },
    timing: { on: false, aheadHours: 24 },
    windowHours: DEFAULT_WINDOW_HOURS,
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function int(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback
}

/** "7", "7:30", "07:30", "19:05" to "HH:MM"; null for anything else. */
export function parseClock(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function quiet(v: unknown): QuietHours | null {
  const o = obj(v)
  const start = parseClock(o['start'])
  const end = parseClock(o['end'])
  return start && end && start !== end ? { start, end } : null
}

/**
 * Any stored shape to a complete, valid settings object. Reads the 1.56.0
 * shape too ({enabled, leadMinutes, windowHours}), where `enabled` meant
 * meeting briefings, so an owner who turned briefings on keeps them on.
 */
export function normalize(raw: unknown): ProactiveSettings {
  const d = defaultSettings()
  const r = obj(raw)
  const b = obj(r['briefing'])
  const t = obj(r['travel'])
  const g = obj(r['timing'])
  const legacy = !('briefing' in r)
  const L = LIMITS
  return {
    briefing: {
      on: legacy ? r['enabled'] === true : b['on'] === true,
      leadMinutes: int(legacy ? r['leadMinutes'] : b['leadMinutes'], L.leadMinutes.min, L.leadMinutes.max, d.briefing.leadMinutes),
    },
    travel: {
      on: t['on'] === true,
      bufferMinutes: int(t['bufferMinutes'], L.bufferMinutes.min, L.bufferMinutes.max, d.travel.bufferMinutes),
      mode: TRAVEL_MODES.includes(t['mode'] as TravelMode) ? (t['mode'] as TravelMode) : d.travel.mode,
      origin: typeof t['origin'] === 'string' ? t['origin'].trim().slice(0, MAX_ORIGIN) : '',
    },
    timing: {
      on: g['on'] === true,
      aheadHours: int(g['aheadHours'], L.aheadHours.min, L.aheadHours.max, d.timing.aheadHours),
    },
    windowHours: int(r['windowHours'], 1, 72, d.windowHours),
  }
}

export function getSettings(): ProactiveSettings {
  const raw = getAppState(SETTINGS_KEY)
  if (!raw) return defaultSettings()
  try {
    return normalize(JSON.parse(raw))
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(s: ProactiveSettings): void {
  setAppState(SETTINGS_KEY, JSON.stringify(normalize(s)))
}

/** At least one kind that runs on this version is on. */
export function anyOn(s: ProactiveSettings): boolean {
  return KINDS.some((k) => k.available && s[k.id].on)
}

// ---------- quiet hours (shared with email alerts) ----------

export function getQuietHours(): QuietHours | null {
  const a = getAlertSettings()
  return a.quietStart === a.quietEnd ? null : { start: a.quietStart, end: a.quietEnd }
}

function setQuietHours(q: QuietHours | null): void {
  const a = getAlertSettings()
  // Same start and end is how email alerts stores "none"; keep its times.
  saveAlertSettings(q ? { ...a, quietStart: q.start, quietEnd: q.end } : { ...a, quietEnd: a.quietStart })
}

/** When the quiet hours `nowMs` falls in end, or null when it is not in quiet hours. */
export function quietUntil(nowMs: number, tz: string, q: QuietHours | null): number | null {
  if (!q) return null
  const now = new Date(nowMs)
  return inQuietHours(now, tz, q.start, q.end) ? nextQuietEnd(now, tz, q.end) : null
}

// ---------- changes, shared by chat and the web app ----------

export interface ChangeResult {
  ok: boolean
  /** Owner-facing text: what changed, or why it did not. */
  message: string
  settings: ProactiveSettings
}

export interface SettingsChange {
  /** Kinds to turn on or off. Unavailable kinds are refused. */
  on?: Partial<Record<MessageKind, boolean>>
  leadMinutes?: number
  quietHours?: QuietHours | null
}

const KIND_NAMES: Record<MessageKind, string> = {
  briefing: 'Meeting briefings',
  travel: 'Travel messages',
  timing: 'Timing warnings',
}

export function kindName(k: MessageKind): string {
  return KIND_NAMES[k]
}

/** What turning a kind on means, in the owner's words. */
function onText(k: MessageKind, s: ProactiveSettings): string {
  switch (k) {
    case 'briefing':
      return `${KIND_NAMES.briefing} are on. About ${s.briefing.leadMinutes} minutes before a meeting with other people, I check recent mail with the attendees and message you only when something needs your attention.`
    case 'travel':
      return `${KIND_NAMES.travel} are on.`
    case 'timing':
      return `${KIND_NAMES.timing} are on.`
  }
}

export function quietText(q: QuietHours | null): string {
  return q
    ? `Quiet hours are ${q.start} to ${q.end}, for email alerts and meeting messages alike. A meeting message due then waits until ${q.end}, or is dropped if the meeting has started by then.`
    : 'No quiet hours are set.'
}

/**
 * Validates and applies a change. `calendars` lists what would be read (for
 * example "me@x.com (Google)"); turning a kind on with none connected is
 * refused, and turning one on says what it will read.
 */
export function applyChange(current: ProactiveSettings, change: SettingsChange, calendars: string[]): ChangeResult {
  const next = normalize(JSON.parse(JSON.stringify(current)))
  const lines: string[] = []
  const fail = (message: string): ChangeResult => ({ ok: false, message, settings: current })

  if (change.leadMinutes !== undefined) {
    const n = change.leadMinutes
    const { min, max } = LIMITS.leadMinutes
    if (!Number.isInteger(n) || n < min || n > max) return fail(`Give the lead time in minutes, from ${min} to ${max}.`)
    next.briefing.leadMinutes = n
  }

  const quietBefore = getQuietHours()
  let quietAfter = quietBefore
  if (change.quietHours !== undefined) {
    if (change.quietHours === null) quietAfter = null
    else {
      quietAfter = quiet(change.quietHours)
      if (!quietAfter) return fail('Give quiet hours as two different times, like 22:00 and 07:00.')
    }
  }

  let turnedOn: MessageKind[] = []
  for (const [k, want] of Object.entries(change.on ?? {}) as [MessageKind, boolean][]) {
    const info = KINDS.find((x) => x.id === k)
    if (!info) continue
    if (want && !info.available) return fail(`${KIND_NAMES[k]} are not available yet.`)
    if (want && !current[k].on) turnedOn.push(k)
    if (!want && current[k].on) lines.push(`${KIND_NAMES[k]} are off.`)
    next[k].on = want
  }
  if (turnedOn.length > 0 && calendars.length === 0) {
    return fail('No calendar is connected, so there is nothing to read yet. Connect Google or Outlook first, then turn this on.')
  }
  turnedOn = turnedOn.filter((k) => next[k].on)
  for (const k of turnedOn) lines.push(onText(k, next))
  if (turnedOn.length > 0) {
    lines.push(`I read the calendar and mail of: ${calendars.join(', ')}. I never reply, send or change anything on my own.`)
  }

  if (change.leadMinutes !== undefined && !turnedOn.includes('briefing') && change.leadMinutes !== current.briefing.leadMinutes) {
    lines.push(`Briefings now arrive about ${next.briefing.leadMinutes} minutes before a meeting.`)
  }
  const quietChanged = JSON.stringify(quietAfter) !== JSON.stringify(quietBefore)
  if (quietChanged) lines.push(quietAfter ? quietText(quietAfter) : 'Quiet hours are off.')

  saveSettings(next)
  if (quietChanged) setQuietHours(quietAfter)
  return { ok: true, message: lines.join('\n') || 'Nothing changed.', settings: next }
}
