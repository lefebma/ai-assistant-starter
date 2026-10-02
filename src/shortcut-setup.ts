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

/** The signed, generic shortcut /shortcut hands over (built by scripts/shortcuts/). */
export const SHORTCUT_TEMPLATE = join('templates', 'shortcuts', 'Ask Havn.shortcut')

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
export function shortcutSetupMessage(reach: 'public' | 'lan', waitSeconds: number, withFile: boolean): string {
  const byHand = [
    'In the Shortcuts app, make a new shortcut called "Ask Havn" (that name is what you say to Siri), then add:',
    '1. Ask for Input. Prompt: What do you need?',
    '2. Get Contents of URL. URL: the address below. Show more: Method POST. Headers: Authorization, set to the line starting with Bearer. Request Body: JSON, with a Text field named text set to Provided Input.',
    '3. Show Result, showing Contents of URL.',
  ]
  return [
    'You can talk to me from Siri, the Action Button, or a home screen icon.',
    '',
    ...(withFile
      ? [
          '1. On your iPhone, open the "Ask Havn" file above and tap Add Shortcut.',
          '2. It asks two questions. First paste the key (the last message, starting with Bearer), then the address (the message starting with http).',
          '3. Say "Hey Siri, Ask Havn".',
          '',
          'If the file will not open, build it by hand instead.',
          ...byHand,
        ]
      : [...byHand, '', 'Then say "Hey Siri, Ask Havn".']),
    '',
    `Answers that take longer than about ${waitSeconds} seconds arrive here in the chat instead, and so do files.`,
    ...(reach === 'lan'
      ? ['', 'This assistant has no public address, so the shortcut only works when your phone is on the same Wi-Fi as it.']
      : []),
    '',
    'The key lets anyone holding it talk to me as you. Do not share it, and delete it from this chat once the shortcut works. /shortcut revoke turns it off; /shortcut again replaces it.',
  ].join('\n')
}
