/**
 * Live call history: the list of past calls for one chat, each call's
 * transcript, deleting one, and pruning old ones. Card #193.
 *
 * The source of truth is the markdown saveVoiceCall (voice-live.ts) writes
 * under store/voice-transcripts/<chat>/, so calls saved before this module
 * existed show up too. A chat only ever sees its own directory.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { resolve, basename, sep } from 'node:path'
import { STORE_DIR, VOICE_TRANSCRIPT_DAYS } from './config.js'
import { installTimezone } from './env.js'
import { logger } from './logger.js'

const TRANSCRIPT_ROOT = () => resolve(STORE_DIR, 'voice-transcripts') // store/ is preserved by updates
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/
const TITLE_CHARS = 70

/**
 * One directory per chat. Chat ids come from platforms (Teams ids carry ':',
 * '@' and '.'), so map everything but letters, digits, '_' and '-' to '_'.
 * Dots go too: a chat id of '..' must never resolve outside the transcript
 * root. The containment check is the backstop if the mapping ever changes.
 */
export function transcriptDirFor(chatId: string, root: string = TRANSCRIPT_ROOT()): string {
  const safe = chatId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'voice'
  const base = resolve(root)
  const dir = resolve(base, safe)
  if (!dir.startsWith(base + sep)) throw new Error('voice transcript path escaped its root')
  return dir
}

export interface CallTurn {
  who: 'user' | 'assistant'
  text: string
}

export interface CallSummary {
  id: string
  title: string
  /** Epoch ms. */
  startedAt: number
  /** Call length in seconds, or null when the transcript does not say. */
  seconds: number | null
  lookups: number
}

export interface CallDetail extends CallSummary {
  heading: string
  turns: CallTurn[]
}

/** Offset in minutes of `timeZone` at the instant `utcMs`. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
  } catch {
    return 0
  }
}

/** Filenames are install-timezone wall time: 2026-10-05-21-59-TFoyKi. */
export function stampToMs(id: string, timeZone: string, fallback: number): number {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/)
  if (!m) return fallback
  const [, y, mo, d, h, mi] = m.map(Number)
  const naive = Date.UTC(y, mo - 1, d, h, mi)
  return naive - offsetMinutes(naive, timeZone) * 60_000
}

function titleFrom(turns: CallTurn[]): string {
  // The first thing the user said that is more than a greeting.
  const said = turns.filter((t) => t.who === 'user').map((t) => t.text.replace(/\s+/g, ' ').trim())
  const pick = said.find((s) => s.split(' ').length > 3) ?? said[0] ?? 'Voice call'
  return pick.length > TITLE_CHARS ? pick.slice(0, TITLE_CHARS - 1).trimEnd() + '…' : pick
}

/** Parse one transcript file. Exported for tests. */
export function parseTranscript(id: string, raw: string, mtimeMs: number, timeZone: string = installTimezone()): CallDetail {
  const lines = raw.split('\n')
  const heading = lines.find((l) => l.startsWith('# '))?.slice(2).trim() ?? 'Voice call'
  const meta = (key: string) => lines.find((l) => l.startsWith(`- ${key}:`))?.slice(key.length + 3).trim()

  const turns: CallTurn[] = []
  for (const line of lines) {
    const m = line.match(/^\*\*(User|Assistant):\*\*\s?(.*)$/)
    if (m) turns.push({ who: m[1] === 'User' ? 'user' : 'assistant', text: m[2] })
    else if (turns.length && line.trim()) turns[turns.length - 1].text += '\n' + line
  }
  for (const t of turns) t.text = t.text.trim()

  const started = Date.parse(meta('Started') ?? '')
  const exact = Number(meta('Seconds'))
  const duration = meta('Duration') ?? ''
  const billed = duration.match(/\((\d+)s billed\)/)
  const approx = duration.match(/~(\d+) min/)
  return {
    id,
    title: titleFrom(turns),
    heading,
    startedAt: Number.isFinite(started) ? started : stampToMs(id, timeZone, mtimeMs),
    seconds: exact > 0 ? exact : billed ? Number(billed[1]) : approx ? Number(approx[1]) * 60 : null,
    lookups: Number(lines.map((l) => l.match(/^- (\d+) backend lookups?$/i)?.[1]).find(Boolean) ?? 0) || 0,
    turns,
  }
}

/** Past calls for one chat, newest first. */
export function listVoiceCalls(chatId: string, opts: { root?: string; limit?: number; timeZone?: string } = {}): CallSummary[] {
  const dir = transcriptDirFor(chatId, opts.root)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files
    .map((f) => {
      const path = resolve(dir, f)
      const { turns: _t, heading: _h, ...summary } = parseTranscript(basename(f, '.md'), readFileSync(path, 'utf-8'), statSync(path).mtimeMs, opts.timeZone)
      return summary
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, opts.limit ?? 100)
}

function callPath(chatId: string, id: string, root?: string): string | null {
  if (!ID_RE.test(id)) return null
  const dir = transcriptDirFor(chatId, root)
  const path = resolve(dir, `${id}.md`)
  return path.startsWith(dir + sep) ? path : null
}

/** One call of this chat by id (the filename without .md), or null. */
export function getVoiceCall(chatId: string, id: string, opts: { root?: string; timeZone?: string } = {}): CallDetail | null {
  const path = callPath(chatId, id, opts.root)
  if (!path) return null
  try {
    return parseTranscript(id, readFileSync(path, 'utf-8'), statSync(path).mtimeMs, opts.timeZone)
  } catch {
    return null
  }
}

/** Delete one call's transcript. Memories already made from it are not touched. */
export function deleteVoiceCall(chatId: string, id: string, opts: { root?: string } = {}): boolean {
  const path = callPath(chatId, id, opts.root)
  if (!path) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Remove transcripts older than `days` across every chat. 0 keeps everything.
 * Age is the file's modification time, which is when the call was saved.
 */
export function pruneVoiceTranscripts(days: number = VOICE_TRANSCRIPT_DAYS, opts: { root?: string; now?: number } = {}): number {
  if (!days || days <= 0) return 0
  const root = resolve(opts.root ?? TRANSCRIPT_ROOT())
  const cutoff = (opts.now ?? Date.now()) - days * 86_400_000
  let removed = 0
  let chats: string[]
  try {
    chats = readdirSync(root)
  } catch {
    return 0
  }
  for (const chat of chats) {
    const dir = resolve(root, chat)
    let files: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const f of files) {
      const path = resolve(dir, f)
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path)
          removed++
        }
      } catch {
        // Gone already, or unreadable: leave it for the next pass.
      }
    }
  }
  if (removed) logger.info({ removed, days }, 'old voice transcripts pruned')
  return removed
}
