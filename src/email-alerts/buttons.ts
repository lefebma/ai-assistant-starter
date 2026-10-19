import {
  findAlertByChatMessage,
  findAlertById,
  findMenu,
  getSettings,
  listAdd,
  listRemove,
  recordAction,
  registerMenu,
  saveSettings,
  setFeedback,
} from './store.js'
import { pauseUntil, senderAddress, type PauseDuration } from './rules.js'
import { localDay, nextDay } from '../ms/time.js'

export const PAUSE_BUTTONS = [
  '1 hour',
  'Until tomorrow morning',
  '1 day',
  '1 week',
  'Until I turn it back on',
]

const DURATION_BY_LABEL: Record<string, PauseDuration> = {
  '1 hour': '1h',
  'Until tomorrow morning': 'tomorrow',
  '1 day': '1d',
  '1 week': '1w',
  'Until I turn it back on': 'off',
}

export interface AlertClickIo {
  send: (text: string, buttons?: string[]) => Promise<{ chatId: string; messageId: string } | null>
  now: () => Date
  tz: string
}

/** "3:15 pm" today, "7:00 am tomorrow", or "Mon 9:00 am" further out. */
export function formatWhen(at: Date, now: Date, tz: string): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(at)
    .replace(/\s?(AM|PM)$/i, (_m, ap: string) => ` ${ap.toLowerCase()}`)
  const day = localDay(at, tz)
  const today = localDay(now, tz)
  if (day === today) return time
  if (day === nextDay(today)) return `${time} tomorrow`
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at)
  return `${wd} ${time}`
}

/** Applies a pause, saves it, and returns the confirmation copy. */
export function pauseFor(d: PauseDuration, now: Date, tz: string): string {
  const settings = getSettings()
  const until = pauseUntil(d, now, tz, settings.quietEnd)
  saveSettings({
    ...settings,
    pauseUntil: until,
    pauseIndefinite: until === null,
    pauseStartedAt: now.getTime(),
  })
  if (until === null) return 'Email alerts paused until you turn them back on.'
  return `Email alerts paused until ${formatWhen(new Date(until), now, tz)}.`
}

const ALREADY = 'Already done.'

/** Handles a click on an alert or on one of its menus. False means it is not ours. */
export async function handleAlertClick(
  chatId: string,
  chatMessageId: string,
  label: string,
  io: AlertClickIo
): Promise<boolean> {
  const alert = findAlertByChatMessage(chatId, chatMessageId)
  if (alert) {
    const address = senderAddress(alert.sender)
    switch (label) {
      case 'Useful':
        if (!recordAction(alert.id, 'useful')) await io.send(ALREADY)
        else {
          setFeedback(alert.id, 'useful')
          await io.send('Noted.')
        }
        return true
      case 'Not urgent':
        if (!recordAction(alert.id, 'not_urgent')) await io.send(ALREADY)
        else {
          setFeedback(alert.id, 'not_urgent')
          await io.send("Noted, I'll hold back on ones like that.")
        }
        return true
      case 'Mute sender': {
        if (!recordAction(alert.id, 'mute')) {
          await io.send(ALREADY)
          return true
        }
        listAdd('mute', address)
        const sent = await io.send(`Muted ${address}.`, ['Undo mute'])
        if (sent) registerMenu(sent.chatId, sent.messageId, 'undo_mute', alert.id)
        return true
      }
      case 'Pause alerts': {
        if (!recordAction(alert.id, 'pause')) {
          await io.send(ALREADY)
          return true
        }
        const sent = await io.send('How long?', PAUSE_BUTTONS)
        if (sent) registerMenu(sent.chatId, sent.messageId, 'pause', alert.id)
        return true
      }
      default:
        return false
    }
  }

  const menu = findMenu(chatId, chatMessageId)
  if (!menu) return false
  if (menu.kind === 'undo_mute' && label === 'Undo mute') {
    if (menu.alertId !== null) {
      const a = findAlertById(menu.alertId)
      if (!recordAction(menu.alertId, 'unmute')) {
        await io.send(ALREADY)
        return true
      }
      if (a) {
        listRemove('mute', senderAddress(a.sender))
        await io.send(`Unmuted ${senderAddress(a.sender)}.`)
      }
    }
    return true
  }
  if (menu.kind === 'pause' && label in DURATION_BY_LABEL) {
    if (menu.alertId !== null && !recordAction(menu.alertId, 'pause_set')) {
      await io.send(ALREADY)
      return true
    }
    await io.send(pauseFor(DURATION_BY_LABEL[label]!, io.now(), io.tz))
    return true
  }
  return false
}
