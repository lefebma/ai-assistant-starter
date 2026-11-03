/**
 * The anonymizer's list of names and its on/off switch (card #187).
 *
 * The list lives in this box's SQLite store and nowhere else: it is the one
 * thing that ties a placeholder to a real name, so it is never sent anywhere.
 * The owner adds names and companies with /private add. Email addresses and
 * phone numbers are added by themselves the first time one is about to be
 * sent (source 'auto').
 *
 * The switch: PRIVACY=on in .env turns it on for every chat and cannot be
 * turned off from a chat. Otherwise each chat turns it on for itself with
 * /private on, kept in app_state as privacy:<chatId>.
 */
import { getAppState, getDb, setAppState } from '../db.js'
import { readEnvFile } from '../env.js'
import { findContactDetails, Masker, placeholderFor, type Entry, type Kind, KINDS } from './mask.js'

type Row = { id: number; kind: string; value: string; aliases: string; source: string }

export type ListedEntry = Entry & { source: 'owner' | 'auto' }

function toEntry(r: Row): ListedEntry {
  let aliases: string[] = []
  try {
    const parsed = JSON.parse(r.aliases)
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string')
  } catch {
    /* a bad row keeps its main value */
  }
  const kind = (KINDS as readonly string[]).includes(r.kind) ? (r.kind as Kind) : 'other'
  return { id: r.id, kind, value: r.value, aliases, source: r.source === 'auto' ? 'auto' : 'owner' }
}

let cached: { version: number; masker: Masker } | null = null
let version = 0

/** Every entry, oldest first. */
export function listEntries(): ListedEntry[] {
  return (getDb().prepare('SELECT id, kind, value, aliases, source FROM privacy_names ORDER BY id').all() as Row[]).map(toEntry)
}

/** The masker for the current list. Rebuilt only after the list changes. */
export function currentMasker(): Masker {
  if (cached && cached.version === version) return cached.masker
  const masker = new Masker(listEntries())
  cached = { version, masker }
  return masker
}

/** Test seam: forget the cached masker. */
export function resetPrivacyCache(): void {
  cached = null
  version++
}

export function addEntry(kind: Kind, value: string, aliases: string[] = [], source: 'owner' | 'auto' = 'owner'): ListedEntry {
  const clean = aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== value.trim().toLowerCase())
  const info = getDb()
    .prepare('INSERT INTO privacy_names (kind, value, aliases, source, created_at) VALUES (?, ?, ?, ?, unixepoch())')
    .run(kind, value.trim(), JSON.stringify(clean), source)
  version++
  return { id: Number(info.lastInsertRowid), kind, value: value.trim(), aliases: clean, source }
}

/** Add aliases to an existing entry. */
export function addAliases(id: number, aliases: string[]): ListedEntry | null {
  const e = listEntries().find((x) => x.id === id)
  if (!e) return null
  const have = new Set([e.value, ...e.aliases].map((a) => a.toLowerCase()))
  const merged = [...e.aliases, ...aliases.map((a) => a.trim()).filter((a) => a && !have.has(a.toLowerCase()))]
  getDb().prepare('UPDATE privacy_names SET aliases = ? WHERE id = ?').run(JSON.stringify(merged), id)
  version++
  return { ...e, aliases: merged }
}

export function removeEntry(id: number): boolean {
  const changed = getDb().prepare('DELETE FROM privacy_names WHERE id = ?').run(id).changes > 0
  if (changed) version++
  return changed
}

/** The entry a name or alias (and, unless told not to, a placeholder) points to. */
export function findEntry(text: string, opts: { placeholders?: boolean } = {}): ListedEntry | undefined {
  const t = text.trim().toLowerCase()
  if (!t) return undefined
  const byPlaceholder = opts.placeholders !== false
  return listEntries().find((e) => [e.value, ...e.aliases].some((f) => f.toLowerCase() === t) || (byPlaceholder && placeholderFor(e).toLowerCase() === t))
}

/**
 * The masker for a request about to go out: any email address or phone
 * number in `texts` that is not on the list yet is added first, so it never
 * leaves the machine either.
 */
export function maskerFor(texts: Iterable<string>): Masker {
  let masker = currentMasker()
  const fresh: Array<{ kind: 'email' | 'phone'; value: string }> = []
  const seen = new Set<string>()
  for (const t of texts) {
    if (!t || (!t.includes('@') && !/\d{3}/.test(t))) continue
    for (const c of findContactDetails(t)) {
      if (masker.hasContact(c.kind, c.value)) continue
      const key = `${c.kind}:${c.value.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(c)
    }
  }
  if (!fresh.length) return masker
  const d = getDb()
  d.transaction(() => {
    for (const c of fresh) addEntry(c.kind, c.value, [], 'auto')
  })()
  masker = currentMasker()
  return masker
}

// --- the switch ---------------------------------------------------------------

const chatKey = (chatId: string) => `privacy:${chatId}`

function envOn(read: (k: string) => string | undefined = defaultRead): boolean {
  return /^(on|1|true|yes)$/i.test(read('PRIVACY') ?? '')
}

function defaultRead(k: string): string | undefined {
  try {
    return readEnvFile()[k]?.trim() || process.env[k]?.trim() || undefined
  } catch {
    return process.env[k]?.trim() || undefined
  }
}

export type PrivacyState = { on: boolean; boxWide: boolean }

/** Whether this chat's turns are anonymized. */
export function privacyState(chatId: string | undefined, read?: (k: string) => string | undefined): PrivacyState {
  if (envOn(read)) return { on: true, boxWide: true }
  if (!chatId) return { on: anyChatOn(), boxWide: false }
  return { on: getAppState(chatKey(chatId)) === 'on', boxWide: false }
}

export function setChatPrivacy(chatId: string, on: boolean): void {
  setAppState(chatKey(chatId), on ? 'on' : 'off')
}

/**
 * True when any chat has it on. A run that belongs to no chat (a background
 * job, memory upkeep) is anonymized whenever any chat is, since what it
 * handles may have come from that chat.
 */
export function anyChatOn(): boolean {
  const row = getDb().prepare("SELECT 1 FROM app_state WHERE key LIKE 'privacy:%' AND value = 'on' LIMIT 1").get()
  return Boolean(row)
}
