/**
 * Names the finder noticed, waiting for the owner's answer (card #275).
 *
 * Each name is offered once, on a card with Add and Not private. Add puts it
 * on the privacy list; Not private is remembered, so it is never asked again.
 * A name already on the list, as its main form or an alias, is never offered.
 * The rows stay in this box's store, like the list itself.
 */
import { getDb } from '../../db.js'
import { addEntry, findEntry } from '../store.js'
import { isAddress, type Found } from './detect.js'

export const ADD = 'Add'
export const NOT_PRIVATE = 'Not private'
export const SUGGESTION_BUTTONS = [ADD, NOT_PRIVATE]

type Row = { id: number; kind: string; value: string; status: string }

/** Store new finds. Returns how many were new. */
export function recordFinds(finds: Found[], nowMs: number = Date.now()): number {
  const d = getDb()
  const insert = d.prepare('INSERT OR IGNORE INTO privacy_suggestions (kind, value, lower, first_seen) VALUES (?, ?, ?, ?)')
  let added = 0
  d.transaction(() => {
    for (const f of finds) {
      if (findEntry(f.value, { placeholders: false })) continue
      added += insert.run(f.kind, f.value, f.value.toLowerCase(), Math.floor(nowMs / 1000)).changes
    }
  })()
  return added
}

/** The oldest name not yet offered. */
export function nextSuggestion(): { id: number; kind: 'person' | 'company'; value: string } | null {
  for (;;) {
    const r = getDb().prepare("SELECT id, kind, value, status FROM privacy_suggestions WHERE status = 'pending' AND card IS NULL AND offered_at IS NULL ORDER BY id LIMIT 1").get() as Row | undefined
    if (!r) return null
    // Added by hand since it was noticed: nothing left to ask.
    if (findEntry(r.value, { placeholders: false })) {
      getDb().prepare("UPDATE privacy_suggestions SET status = 'added' WHERE id = ?").run(r.id)
      continue
    }
    // A web or email address noticed before 1.89.0: never a name to keep private.
    if (isAddress(r.value)) {
      getDb().prepare("UPDATE privacy_suggestions SET status = 'declined' WHERE id = ?").run(r.id)
      continue
    }
    return { id: r.id, kind: r.kind === 'person' ? 'person' : 'company', value: r.value }
  }
}

export function markOffered(id: number, card: string | null, nowMs: number = Date.now()): void {
  getDb().prepare('UPDATE privacy_suggestions SET card = ?, offered_at = ? WHERE id = ?').run(card, Math.floor(nowMs / 1000), id)
}

function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

/** Cards sent on the local day of `nowMs`. */
export function offeredToday(nowMs: number, tz: string): number {
  const today = localDay(nowMs, tz)
  const since = Math.floor(nowMs / 1000) - 2 * 86_400
  const rows = getDb().prepare('SELECT offered_at FROM privacy_suggestions WHERE offered_at >= ?').all(since) as Array<{ offered_at: number }>
  return rows.filter((r) => localDay(r.offered_at * 1000, tz) === today).length
}

export function suggestionText(value: string, buttons: boolean): string {
  const ask = `Keep ${value} private? It came up in your messages.`
  return buttons
    ? `${ask} Add means the AI service never sees that name: I swap it for a stand-in before sending and put the real name back in my replies.`
    : `${ask} I can make sure the AI service never sees that name: I swap it for a stand-in before sending and put the real name back in my replies. To do that, reply /private add ${value}`
}

/** A tap on a suggestion card. Null when the card is something else, so the click never reaches the model. */
export function resolveSuggestionClick(primary: boolean, cardId: string, label: string): string | null {
  if (label !== ADD && label !== NOT_PRIVATE) return null
  const r = getDb().prepare('SELECT id, kind, value, status FROM privacy_suggestions WHERE card = ?').get(cardId) as Row | undefined
  if (!r) return null
  if (!primary) return 'That one only works in your main chat.'
  if (r.status !== 'pending') return 'Already done.'
  if (label === NOT_PRIVATE) {
    getDb().prepare("UPDATE privacy_suggestions SET status = 'declined' WHERE id = ?").run(r.id)
    return `Okay, I won't ask about ${r.value} again.`
  }
  if (!findEntry(r.value, { placeholders: false })) addEntry(r.kind === 'person' ? 'person' : 'company', r.value)
  getDb().prepare("UPDATE privacy_suggestions SET status = 'added' WHERE id = ?").run(r.id)
  return `Added ${r.value}. It stays on this machine whenever the privacy filter is on.`
}
