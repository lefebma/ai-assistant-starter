/** What tips say. Plain text; each platform formats it on the way out. */
import type { Tip } from './catalog.js'

export const GOT_IT = 'Got it'
export const NOT_FOR_ME = 'Not for me'
export const TIP_BUTTONS = [GOT_IT, NOT_FOR_ME]

const FIRST_TIME = 'I will suggest something like this now and then. Send /tips off to stop, or /tips less for fewer.'
const HIDE_HINT = 'Not useful? Send /tips hide and I will not suggest it again.'

function hints(buttons: boolean, firstEver: boolean): string[] {
  return [...(firstEver ? [FIRST_TIME] : []), ...(buttons ? [] : [HIDE_HINT])]
}

export function renderTip(tip: Tip, opts: { buttons: boolean; firstEver: boolean }): string {
  return [`Tip: ${tip.text}`, `Try it: ${tip.tryIt}`, ...hints(opts.buttons, opts.firstEver)].join('\n\n')
}

export function renderUpdateTips(version: string, tips: Tip[], opts: { buttons: boolean; firstEver: boolean }): string {
  return [`New in ${version}:`, ...tips.map((t) => `${t.text}\n${t.tryIt}`), ...hints(opts.buttons, opts.firstEver)].join('\n\n')
}
