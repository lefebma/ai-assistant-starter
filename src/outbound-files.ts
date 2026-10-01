/**
 * `[[file: path]]`: how the assistant hands the owner an actual file.
 *
 * Everything the assistant produces reaches the owner as text, which is fine
 * for an answer and useless for a screenshot, a PDF, or the CSV it just
 * built. It had no way to say "here is the file", only to name a path on a
 * machine the owner is not sitting at. This is the other half of the
 * adapters' sendFile.
 *
 * On the path rules below, and what they are not: the assistant has a shell,
 * so anything it can read it can also copy somewhere allowed. These rules are
 * a guard against a careless send, not a security boundary. The boundary that
 * matters is the destination: a file only ever goes to a chat that is already
 * authorized to talk to this assistant, which is the owner's own chat. That
 * is why "send me the config" cannot become someone else's copy of it.
 *
 * What the rules do buy is that a mistake stays a mistake. A reply that
 * drifts into `[[file: .env]]`, or an instruction smuggled in through an
 * email asking for one, does not quietly put a key in a chat history that
 * lives on a phone. It comes back as a refused line the owner can see.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'

const FILE_RE = /\[\[file:\s*([^\]]+)\]\]/gi

/** Four per reply. More than that is a directory listing, not a delivery. */
export const MAX_OUTBOUND_FILES = 4

/**
 * Read bound, not a platform limit. Telegram takes 50 MB and the Teams
 * consent flow is capped at 20 MB in the adapter; this only stops the bot
 * from reading something enormous before either of them gets a say.
 */
export const MAX_OUTBOUND_BYTES = 25 * 1024 * 1024

// Only what a chat client will show as a picture. svg and bmp are files as
// far as Telegram's sendPhoto and Teams' inline images are concerned, so
// calling them photos would just make the send fail.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Files that are never what the owner meant, by name. Keys, credential
 * stores, and the assistant's own database, which holds every memory and
 * every conversation turn it has saved.
 */
const NEVER_SEND = [
  /(^|\.)env(\..*)?$/i,
  /\.(key|pem|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /credential/i,
  /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i,
  /^\.?(netrc|npmrc|pgpass|htpasswd)$/i,
  /token/i,
  /secret/i,
]

export interface OutboundFileRequest {
  /** Exactly as the assistant wrote it, for the refusal message. */
  requested: string
}

export function extractFileMarkers(text: string): { cleanText: string; requests: OutboundFileRequest[] } {
  const requests: OutboundFileRequest[] = []
  for (const match of text.matchAll(FILE_RE)) {
    const requested = match[1].trim()
    if (requested) requests.push({ requested })
  }
  return {
    cleanText: text.replace(FILE_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    requests: requests.slice(0, MAX_OUTBOUND_FILES),
  }
}

export type Resolution =
  | { ok: true; path: string; name: string; kind: 'photo' | 'document' }
  | { ok: false; reason: string }

export interface ResolveRoots {
  projectRoot: string
  uploadsDir: string
}

/** True when `child` is inside `parent`, with no prefix-match near misses. */
function contains(parent: string, child: string): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(base)
}

/**
 * Turn what the assistant wrote into a file we are willing to send.
 *
 * Symlinks are resolved before the containment check, not after: a link
 * inside the project pointing at /etc/shadow is inside the project only until
 * someone follows it, and we are the ones following it.
 */
export function resolveOutboundFile(requested: string, roots: ResolveRoots): Resolution {
  if (requested.includes('\0')) return { ok: false, reason: 'that path is not a path' }
  if (requested.startsWith('~')) {
    return { ok: false, reason: 'use a path inside the project, not a home-relative one' }
  }

  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(roots.projectRoot, requested)
  if (!existsSync(absolute)) return { ok: false, reason: 'no such file' }

  let real: string
  try {
    real = realpathSync(absolute)
  } catch {
    return { ok: false, reason: 'no such file' }
  }

  const insideProject = contains(realpathish(roots.projectRoot), real)
  const insideUploads = contains(realpathish(roots.uploadsDir), real)
  if (!insideProject && !insideUploads) {
    return { ok: false, reason: 'it is outside the project folder' }
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(real)
  } catch {
    return { ok: false, reason: 'no such file' }
  }
  if (!stats.isFile()) return { ok: false, reason: 'it is not a file' }
  if (stats.size === 0) return { ok: false, reason: 'it is empty' }
  if (stats.size > MAX_OUTBOUND_BYTES) {
    return { ok: false, reason: `it is ${(stats.size / (1024 * 1024)).toFixed(1)} MB, too big to send` }
  }

  const name = basename(real)
  if (NEVER_SEND.some((re) => re.test(name))) {
    return { ok: false, reason: 'that file holds credentials or private state, so I do not send it into a chat' }
  }

  const ext = extname(name).replace('.', '').toLowerCase()
  return { ok: true, path: real, name, kind: IMAGE_EXTENSIONS.has(ext) ? 'photo' : 'document' }
}

/** realpath the root too, so /var vs /private/var on macOS cannot fail a match. */
function realpathish(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
