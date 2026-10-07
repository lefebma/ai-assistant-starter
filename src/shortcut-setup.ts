/**
 * What `/shortcut` tells the owner: where to point a Shortcut and how to build
 * one. Kept out of bot.ts so the wording can be tested without a bot.
 */
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

export const SHORTCUT_PATH = '/api/shortcut'

/**
 * The address a Shortcut posts to, or null when there is none worth giving.
 *
 * A box with an edge has a public name and that is the answer. A box without
 * one (a Mac at home) can still be reached from a phone on the same Wi-Fi, so
 * it gets its LAN address and says so; a Shortcut that only works at home is
 * still worth having, and pretending otherwise would be the bug.
 */
export function shortcutUrl(
  publicHostname: string,
  httpPort: number,
  lanAddress: string | null = firstLanAddress()
): { url: string; reach: 'public' | 'lan' } | null {
  if (publicHostname) return { url: `https://${publicHostname}${SHORTCUT_PATH}`, reach: 'public' }
  if (lanAddress) return { url: `http://${lanAddress}:${httpPort}${SHORTCUT_PATH}`, reach: 'lan' }
  return null
}

/** First private IPv4 address, the one a phone on the same network can reach. */
export function firstLanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        return a.address
      }
    }
  }
  return null
}

/**
 * The signed, generic shortcut /shortcut hands over (built by scripts/shortcuts/).
 *
 * "Haven", not "Havn": the file name becomes the shortcut's name, and the
 * name is what Siri has to match against what it heard. Spoken, Havn is
 * transcribed as Haven, so a shortcut called Ask Havn never runs by voice and
 * Siri answers the question itself instead. Found on a real iPhone, 2026-10-05.
 */
export const SHORTCUT_TEMPLATE = join('templates', 'shortcuts', 'Ask Haven.shortcut')

/** What the shortcut is called when the box has no name for its assistant. */
export const DEFAULT_SHORTCUT_NAME = 'Haven'

/**
 * The assistant's name, so the shortcut can be "Ask Joy" rather than "Ask
 * Haven" (card #152; Marina's assistant is Joy, and a reseller's client will
 * have a name of their own).
 *
 * The signed file carries no name of its own (the builder writes none), so
 * the iPhone names an imported shortcut after the file, and renaming the file
 * is all it takes. Read from what setup writes: "Your name is Joy." in
 * PERSONALITY.md, which the owner is most likely to have edited, then the
 * "# Joy" heading of CLAUDE.md. Anything that still looks like a template
 * placeholder, or that would make a bad file name or Siri phrase, is ignored.
 */
export function assistantName(personality: string | null, claudeMd: string | null): string | null {
  const fromPersonality = personality?.match(/\bYour name is ([^.\n]+)\./)?.[1]
  const fromHeading = claudeMd?.match(/^#\s+(.+)$/m)?.[1]
  for (const raw of [fromPersonality, fromHeading]) {
    const name = cleanName(raw)
    if (name) return name
  }
  return null
}

function cleanName(raw: string | undefined): string | null {
  const name = (raw ?? '').trim().replace(/[*_`]/g, '').replace(/\s+/g, ' ')
  if (!name || name.includes('{{') || name.length > 24) return null
  // Letters (any script), digits, spaces, apostrophes, hyphens and dots only:
  // it becomes a file name on three platforms and a phrase Siri has to match.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '.-]*$/u.test(name)) return null
  return name
}

/**
 * The name to put on the shortcut, as Siri will hear it. "Havn" is said
 * "Haven", and a shortcut called Ask Havn never matched by voice on a real
 * iPhone (2026-10-05), so the brand's own spelling is the one name rewritten.
 */
export function spokenShortcutName(name: string | null): string {
  if (!name || /^havn$/i.test(name)) return DEFAULT_SHORTCUT_NAME
  return name
}

/** "Ask Joy.shortcut": the file name is the shortcut's name once imported. */
export function shortcutFileName(name: string): string {
  return `Ask ${name}.shortcut`
}

/**
 * The instructions. The address and the key follow in messages of their own
 * so each can be copied with one long-press on a phone, which is where the
 * owner will be setting this up.
 *
 * With the file, setup is: open it, tap Add, paste two lines. The file asks
 * for the key first and then the address, because Shortcuts asks its import
 * questions in action order; the wording here has to match that order. The
 * by-hand steps stay as the fallback for a phone that will not open the file.
 */
export function shortcutSetupMessage(
  reach: 'public' | 'lan',
  waitSeconds: number,
  withFile: boolean,
  name: string = DEFAULT_SHORTCUT_NAME
): string {
  const ask = `Ask ${name}`
  const byHand = [
    `In the Shortcuts app, make a new shortcut called "${ask}" (that name is what you say to Siri), then add:`,
    '1. Ask for Input. Prompt: What do you need?',
    '2. Get Contents of URL. URL: the address below. Show more: Method POST. Headers: Authorization, set to the line starting with Bearer. Request Body: JSON, with a Text field named text set to Provided Input.',
    '3. Show Result, showing Contents of URL.',
  ]
  return [
    'You can talk to me from Siri, the Action Button, or a home screen icon.',
    '',
    ...(withFile
      ? [
          `1. On your iPhone, open the "${ask}" file above and tap Add Shortcut.`,
          '2. It asks two questions. First paste the key (the last message, starting with Bearer), then the address (the message starting with http).',
          `3. Say "Hey Siri, ${ask}" and nothing else. When it asks what you need, ask.`,
          '',
          'If the file will not open, build it by hand instead.',
          ...byHand,
        ]
      : [...byHand, '', `Then say "Hey Siri, ${ask}" and nothing else. When it asks what you need, ask.`]),
    '',
    `Answers that take longer than about ${waitSeconds} seconds arrive here in the chat instead, and so do files.`,
    ...(reach === 'lan'
      ? ['', 'This assistant has no public address, so the shortcut only works when your phone is on the same Wi-Fi as it.']
      : []),
    '',
    'The key lets anyone holding it talk to me as you. Do not share it, and delete it from this chat once the shortcut works. /shortcut revoke turns it off; /shortcut again replaces it.',
  ].join('\n')
}

/**
 * `/shortcut status`, in words the owner can act on.
 *
 * This used to print "Shortcut key made 2026-10-06 00:38 UTC, last used
 * 2026-10-06 00:45 UTC": the right facts in a form that made the owner do
 * timezone arithmetic to learn whether their phone had just worked. The
 * question behind the command is "is my shortcut working, and when did it
 * last get through", so that is what this answers, in the owner's zone, with
 * recent times relative.
 */
export function describeShortcutKey(
  info: { createdAt: number; lastUsedAt: number | null } | null,
  now: number,
  timeZone: string
): string {
  if (!info) return 'You do not have a shortcut key. Send /shortcut to set one up.'
  const made = `You set it up ${whenWords(info.createdAt, now, timeZone)}`
  const used = info.lastUsedAt
    ? `it last got through ${whenWords(info.lastUsedAt, now, timeZone, true)}`
    : 'it has not been used yet. Try it from your phone'
  return `Your shortcut key is active. ${made}, and ${used}.`
}

/** "just now", "7 minutes ago", "today at 8:38 PM", "yesterday at 9:05 AM", "on Oct 3 at 2:10 PM". */
export function whenWords(at: number, now: number, timeZone: string, relativeIfRecent = false): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (relativeIfRecent && minutes >= 0 && minutes < 60) {
    if (minutes < 1) return 'just now'
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  }
  const day = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
  if (day(at) === day(now)) return `today at ${time}`
  if (day(at) === day(now - 86_400_000)) return `yesterday at ${time}`
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at)
  return `on ${date} at ${time}`
}
