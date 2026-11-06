/**
 * What the tips remember, and every rule about what may go out when. All pure
 * apart from load and save, so the rules can be tested without a clock or a
 * chat. Stored as one value in app_state: it is small, written rarely, and
 * survives updates.
 */
import { getAppState, setAppState } from '../db.js'
import { TIPS, type Tip, type TipContext } from './catalog.js'

export type Pace = 'normal' | 'less' | 'off'

export interface TipRecord {
  shown: number
  lastShown: number
  status?: 'done' | 'dismissed'
}

export interface TipState {
  pace: Pace
  /** First run of this feature, in ms. 0 means not yet. */
  startedAt: number
  /** The last version the owner has been told about. */
  version: string
  /** When tips went out unasked, in ms, kept for a week. */
  sends: number[]
  tips: Record<string, TipRecord>
  /** The last tips sent, shown in the web app until answered. */
  current: { ids: string[]; at: number; asked?: boolean } | null
  /** Which tips each recent card carried, so a click finds them. */
  cards: Array<{ card: string; ids: string[] }>
}

const KEY = 'tips.state'
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MAX_CARDS = 20

/** Not a full day: "one a day" must not slide later each day until it falls out of the window. */
export const MIN_GAP_MS = 20 * 3_600_000
export const WEEKLY_CAP: Record<Pace, number> = { normal: 3, less: 1, off: 0 }
/** The welcome questions own a new box's first days. */
export const FIRST_TIP_HOLD_MS = 2 * DAY_MS
/** The same tip does not come back sooner than this, however short the list. */
export const REPEAT_GAP_MS = 30 * DAY_MS
export const OWNER_IDLE_MS = 30 * 60_000
export const WINDOW_START_HOUR = 10
export const WINDOW_END_HOUR = 17
export const MAX_UPDATE_TIPS = 2
/** The web app stops showing a tip nobody answered after this long. */
export const CURRENT_TTL_MS = WEEK_MS

export function emptyState(): TipState {
  return { pace: 'normal', startedAt: 0, version: '', sends: [], tips: {}, current: null, cards: [] }
}

export function loadState(): TipState {
  const raw = getAppState(KEY)
  if (!raw) return emptyState()
  try {
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<TipState>) }
  } catch {
    return emptyState()
  }
}

export function saveState(s: TipState): void {
  setAppState(KEY, JSON.stringify(s))
}

/** a is a later version than b. An empty or malformed version is the earliest. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

function record(s: TipState, id: string): TipRecord {
  return (s.tips[id] ??= { shown: 0, lastShown: 0 })
}

export function markDone(s: TipState, id: string): boolean {
  const r = record(s, id)
  if (r.status) return false
  r.status = 'done'
  return true
}

export function markDismissed(s: TipState, ids: string[]): void {
  for (const id of ids) record(s, id).status = 'dismissed'
  if (s.current) {
    const left = s.current.ids.filter((id) => !ids.includes(id))
    s.current = left.length ? { ...s.current, ids: left } : null
  }
}

/** Mark what the box's settings show is already in use. True when anything changed. */
export function markUsed(s: TipState, ctx: TipContext, tips: Tip[] = TIPS): boolean {
  let changed = false
  for (const t of tips) if (t.used?.(ctx) && markDone(s, t.id)) changed = true
  return changed
}

/** The tips a message tried. The text is matched here and never kept. */
export function triedBy(text: string, tips: Tip[] = TIPS): Tip[] {
  const trimmed = text.trim()
  const word = trimmed.split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? ''
  return tips.filter((t) => t.commands?.includes(word) || t.phrases?.test(trimmed))
}

/** Offerable right now. `sinceRepeat` false ignores the 30-day gap, for a tip asked for. */
function open(s: TipState, ctx: TipContext, nowMs: number, sinceRepeat: boolean, tips: Tip[]): Tip[] {
  return tips.filter((t) => {
    const r = s.tips[t.id]
    if (r?.status) return false
    if (t.applies && !t.applies(ctx)) return false
    return !sinceRepeat || !r || nowMs - r.lastShown >= REPEAT_GAP_MS
  })
}

/** Fewest times shown first, then catalog order. This is what makes the list start over. */
function byTurn(s: TipState, list: Tip[], tips: Tip[]): Tip[] {
  const shown = (t: Tip) => s.tips[t.id]?.shown ?? 0
  return [...list].sort((a, b) => shown(a) - shown(b) || tips.indexOf(a) - tips.indexOf(b))
}

export function nextTip(s: TipState, ctx: TipContext, nowMs: number, opts: { asked?: boolean; tips?: Tip[] } = {}): Tip | null {
  const tips = opts.tips ?? TIPS
  return byTurn(s, open(s, ctx, nowMs, !opts.asked, tips), tips)[0] ?? null
}

/** The tips for features newer than the last version the owner was told about. */
export function updateTips(s: TipState, ctx: TipContext, nowMs: number, tips: Tip[] = TIPS): Tip[] {
  return open(s, ctx, nowMs, false, tips)
    .filter((t) => isNewer(t.since, s.version))
    .slice(0, MAX_UPDATE_TIPS)
}

export interface Moment {
  nowMs: number
  localHour: number
  inQuietHours: boolean
  busy: boolean
  /** The owner's last message in ms, 0 when there has been none since the start. */
  lastOwnerMs: number
}

/** Why a tip may not go out now, or null when it may. Each reason goes to the debug log. */
export function holdReason(s: TipState, m: Moment): string | null {
  if (s.pace === 'off') return 'tips are off'
  if (m.inQuietHours) return 'quiet hours'
  if (m.localHour < WINDOW_START_HOUR || m.localHour >= WINDOW_END_HOUR) return 'outside the tip window'
  if (m.busy) return 'a reply is running'
  if (m.lastOwnerMs && m.nowMs - m.lastOwnerMs < OWNER_IDLE_MS) return 'mid-conversation'
  if (s.sends.some((t) => m.nowMs - t < MIN_GAP_MS)) return 'already had one today'
  return null
}

/** Whether a paced tip is allowed on top of holdReason. */
export function paceAllows(s: TipState, nowMs: number): boolean {
  if (nowMs - s.startedAt < FIRST_TIP_HOLD_MS) return false
  return s.sends.filter((t) => nowMs - t < WEEK_MS).length < WEEKLY_CAP[s.pace]
}

function noteShown(s: TipState, ids: string[], nowMs: number): void {
  for (const id of ids) {
    const r = record(s, id)
    r.shown++
    r.lastShown = nowMs
  }
}

/** Tips that went out, on a card when one came back from the platform. */
export function recordSent(s: TipState, ids: string[], card: string | null, nowMs: number, paced: boolean): void {
  noteShown(s, ids, nowMs)
  if (paced) s.sends = [...s.sends.filter((t) => nowMs - t < WEEK_MS), nowMs]
  s.current = paced ? { ids, at: nowMs } : { ids, at: nowMs, asked: true }
  if (card) s.cards = [...s.cards, { card, ids }].slice(-MAX_CARDS)
}

export function currentTips(s: TipState, nowMs: number, tips: Tip[] = TIPS): Tip[] {
  if (!s.current || nowMs - s.current.at >= CURRENT_TTL_MS) return []
  const ids = s.current.ids
  return tips.filter((t) => ids.includes(t.id) && !s.tips[t.id]?.status)
}
