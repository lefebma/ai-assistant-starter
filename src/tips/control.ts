/**
 * The owner's side of tips: /tips, the buttons on a tip, and noticing when a
 * tip has been tried. The same answers in every chat app and the web app.
 */
import { TIPS, type Tip, type TipContext } from './catalog.js'
import { currentTips, loadState, markDismissed, markDone, nextTip, recordSent, saveState, triedBy, type Pace } from './state.js'
import { GOT_IT, NOT_FOR_ME, TIP_BUTTONS, renderTip } from './text.js'

const USAGE = 'Usage: /tips, /tips on, /tips less, /tips off, /tips hide, or /tips hide <number>.'
const PRIMARY_ONLY = 'That one only works in your main chat.'
const NOT_AGAIN = 'Okay, I will not suggest that again.'

const PACE_REPLY: Record<Pace, string> = {
  normal: 'Tips are on: no more than one a day and three a week.',
  less: 'Fewer tips: no more than one a week.',
  off: 'Tips are off. You can still send /tips to ask for one.',
}

/** The owner's last message in the main chat, for "not mid-conversation". */
let lastOwnerMs = 0
export const lastOwnerMessage = (): number => lastOwnerMs

/** The owner did something in the main chat: a message, a voice note, a photo, a tap. */
export function noteOwnerActive(primary: boolean, nowMs: number = Date.now()): void {
  if (primary) lastOwnerMs = nowMs
}

/** Every text the owner sends comes through here. Nothing about it is kept. */
export function noteOwnerMessage(primary: boolean, text: string, nowMs: number = Date.now()): void {
  noteOwnerActive(primary, nowMs)
  const tried = triedBy(text)
  if (tried.length === 0) return
  const s = loadState()
  const changed = tried.map((t) => markDone(s, t.id))
  if (changed.includes(true)) saveState(s)
}

function seenTips(): Tip[] {
  const s = loadState()
  return TIPS.filter((t) => (s.tips[t.id]?.shown ?? 0) > 0 && s.tips[t.id]?.status !== 'dismissed')
}

function seenList(): string {
  const seen = seenTips()
  if (seen.length === 0) return ''
  return ['Seen so far:', ...seen.map((t, i) => `${i + 1}. ${t.text} ${t.tryIt}`)].join('\n')
}

export interface TipsReply {
  text: string
  /** A tip to answer with buttons, when one is being shown. */
  tipIds?: string[]
}

/** /tips and its words. Pure of the chat; the caller sends the reply. */
export function tipsCommand(primary: boolean, arg: string, ctx: TipContext, buttons: boolean, nowMs: number = Date.now()): TipsReply {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const s = loadState()
  if (words.length === 0) {
    const tip = nextTip(s, ctx, nowMs, { asked: true })
    const seen = seenList()
    if (!tip) return { text: [seen, 'You have tried everything I had to suggest. New tips come with updates.'].filter(Boolean).join('\n\n') }
    return { text: [renderTip(tip, { buttons, firstEver: false }), seen].filter(Boolean).join('\n\n'), tipIds: [tip.id] }
  }
  if (!primary) return { text: PRIMARY_ONLY }
  const paces: Record<string, Pace> = { on: 'normal', normal: 'normal', less: 'less', off: 'off' }
  const pace = words.length === 1 ? paces[words[0]!] : undefined
  if (pace) {
    s.pace = pace
    saveState(s)
    return { text: PACE_REPLY[pace] }
  }
  if (words[0] === 'hide' && words.length <= 2) {
    let ids: string[]
    if (words[1]) {
      const n = Number(words[1])
      const pick = Number.isInteger(n) ? seenTips()[n - 1] : undefined
      if (!pick) return { text: `No tip ${words[1]}. Send /tips to see the list.` }
      ids = [pick.id]
    } else {
      ids = currentTips(s, nowMs).map((t) => t.id)
      if (ids.length === 0) return { text: 'There is no recent tip to hide. Send /tips to see the list.' }
    }
    markDismissed(s, ids)
    saveState(s)
    return { text: NOT_AGAIN }
  }
  return { text: USAGE }
}

/** Remember a tip shown because the owner asked. It does not use up the day's tip. */
export function noteAsked(ids: string[], card: string | null, nowMs: number = Date.now()): void {
  const s = loadState()
  recordSent(s, ids, card, nowMs, false)
  saveState(s)
}

/**
 * A tap on a tip's button. Null when the card is not a tip. Handled here so a
 * click never reaches the model.
 */
export function resolveTipClick(primary: boolean, cardId: string, label: string): string | null {
  if (label !== GOT_IT && label !== NOT_FOR_ME) return null
  const card = loadState().cards.find((c) => c.card === cardId)
  if (!card) return null
  if (!primary) return label === NOT_FOR_ME ? PRIMARY_ONLY : 'Okay.'
  return answerTips(card.ids, label === NOT_FOR_ME)
}

function answerTips(ids: string[], hide: boolean): string {
  const s = loadState()
  if (hide) markDismissed(s, ids)
  else if (s.current) {
    const left = s.current.ids.filter((id) => !ids.includes(id))
    s.current = left.length ? { ...s.current, ids: left } : null
  }
  saveState(s)
  return hide ? NOT_AGAIN : 'Okay.'
}

/** The web app's quiet card: what is showing, and its two answers. */
export function webTip(nowMs: number = Date.now()): { ids: string[]; text: string; tryIt: string } | null {
  const s = loadState()
  // One the owner asked for is already in front of them.
  const tips = s.current?.asked ? [] : currentTips(s, nowMs)
  if (tips.length === 0) return null
  return { ids: tips.map((t) => t.id), text: tips.map((t) => t.text).join(' '), tryIt: tips.map((t) => t.tryIt).join(' ') }
}

/** The page names the tips it showed, so a card left open cannot answer a newer one. */
export function answerWebTip(ids: string[], hide: boolean, nowMs: number = Date.now()): void {
  const known = currentTips(loadState(), nowMs).map((t) => t.id)
  answerTips(ids.filter((id) => known.includes(id)), hide)
}

export { TIP_BUTTONS }
