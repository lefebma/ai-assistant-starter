/**
 * The email-alerts loop: every INTERVAL_MS, list new mail in each connected
 * mailbox, decide what is critical, and tell the owner.
 *
 * Order per tick: end a timed pause (and flush), flush after quiet hours,
 * retry failed sends, then read mail. Mute beats VIP, VIP beats triage. A
 * pause records alerts but sends nothing; quiet hours hold everything except
 * VIPs. A pause that ends during quiet hours sends its VIPs at once and
 * leaves its summary for the end of quiet hours.
 *
 * A failed alert send goes to `retry` (no header when it goes out again), up
 * to MAX_SEND_ATTEMPTS sends, then `suppressed`. A failed header changes
 * nothing, so the whole flush is tried again next tick.
 *
 * Log lines here carry counts only, never a subject, a sender or a mailbox.
 */
import { logger } from '../logger.js'
import {
  alertsByStatus,
  getSettings,
  insertAlert,
  listAll,
  markAlertSent,
  markAlertSentQuiet,
  markSeen,
  recordSendFailure,
  saveSettings,
  type AlertRow,
  type AlertStatus,
} from './store.js'
import { inQuietHours, preDecide } from './rules.js'
import type { Mailbox, NewMail } from './sources.js'
import type { TriageInput, TriageOutcome } from './triage.js'
import { ALERT_BUTTONS, formatAlert, formatOverflow, pauseEndHeader, quietEndHeader } from './format.js'

export const INTERVAL_MS = 10 * 60_000
export const MAX_ALERTS_PER_SEND = 5
const FIRST_PASS_MS = 2 * 60_000
const LOOKBACK_MS = 2 * 86_400_000
const VIP_REASON = 'From a VIP'

export interface TickDeps {
  boxes: () => Promise<{ boxes: Mailbox[]; broken: { id: string; why: string }[] }>
  triage: (i: TriageInput) => Promise<TriageOutcome>
  send: (text: string, buttons?: string[]) => Promise<{ chatId: string; messageId: string } | null>
  now: () => Date
  tz: string
}

export interface TickResult {
  sent: number
  held: number
  paused: number
  triaged: number
}

interface Critical {
  mail: NewMail
  reason: string
  vip: boolean
}

async function trySend(
  deps: TickDeps,
  text: string,
  buttons?: string[]
): Promise<{ chatId: string; messageId: string } | null> {
  try {
    return await deps.send(text, buttons)
  } catch {
    return null
  }
}

/** Counts a failed alert send; logs once per batch for any given up. */
function failSends(ids: number[]): void {
  let suppressed = 0
  for (const id of ids) if (recordSendFailure(id) === 'suppressed') suppressed++
  if (ids.length > 0) logger.warn({ failed: ids.length }, 'email-alerts send failed')
  if (suppressed > 0) logger.warn({ suppressed }, 'email-alerts gave up sending')
}

/** One message per row, with buttons. Returns the number sent. */
async function sendEach(deps: TickDeps, rows: AlertRow[]): Promise<number> {
  const at = deps.now().getTime()
  let sent = 0
  const failed: number[] = []
  for (const row of rows) {
    const res = await trySend(deps, formatAlert(row), ALERT_BUTTONS)
    if (res) {
      markAlertSent(row.id, res.chatId, res.messageId, at)
      sent++
    } else {
      failed.push(row.id)
    }
  }
  failSends(failed)
  return sent
}

/**
 * Sends rows (already newest first): up to MAX_ALERTS_PER_SEND with buttons,
 * the rest recorded as sent behind one overflow line. Returns the number of
 * rows now recorded as sent.
 */
async function deliver(deps: TickDeps, rows: AlertRow[]): Promise<number> {
  let delivered = await sendEach(deps, rows.slice(0, MAX_ALERTS_PER_SEND))
  const rest = rows.slice(MAX_ALERTS_PER_SEND)
  if (rest.length > 0) {
    const at = deps.now().getTime()
    for (const row of rest) markAlertSentQuiet(row.id, at)
    delivered += rest.length
    if (!(await trySend(deps, formatOverflow(rest.length)))) {
      logger.warn({ failed: 1 }, 'email-alerts send failed')
    }
  }
  return delivered
}

function newestFirst(rows: AlertRow[]): AlertRow[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
}

/**
 * `pause_end`: the pause summary over paused and held rows. The pause is
 * cleared only once its header is accepted. `quiet_end`: rows held for quiet
 * hours, nothing at all when there are none.
 */
export async function flushHeld(deps: TickDeps, reason: 'quiet_end' | 'pause_end'): Promise<number> {
  const rows =
    reason === 'pause_end'
      ? newestFirst([...alertsByStatus('paused'), ...alertsByStatus('held')])
      : alertsByStatus('held')
  if (reason === 'quiet_end' && rows.length === 0) return 0
  const header = reason === 'pause_end' ? pauseEndHeader(rows.length) : quietEndHeader(rows.length)
  if (!(await trySend(deps, header))) {
    logger.warn({ failed: 1 }, 'email-alerts send failed')
    return 0
  }
  if (reason === 'pause_end') {
    saveSettings({
      ...getSettings(),
      pauseUntil: null,
      pauseStartedAt: null,
      pauseIndefinite: false,
      pauseSummaryPending: false,
    })
  }
  if (rows.length === 0) return 0
  return deliver(deps, rows)
}

function pauseActive(s: ReturnType<typeof getSettings>, nowMs: number): boolean {
  return s.pauseIndefinite || (s.pauseUntil !== null && nowMs < s.pauseUntil)
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const result: TickResult = { sent: 0, held: 0, paused: 0, triaged: 0 }
  let settings = getSettings()
  if (!settings.enabled) return result

  const now = deps.now()
  const nowMs = now.getTime()

  // Retries are taken before this tick's flushes, so a send that fails in a
  // flush below waits a full interval before its next attempt.
  const retrying = alertsByStatus('retry')

  // 1. A timed pause that has run out ends here. During quiet hours its
  // VIPs go out at once and the summary waits for quiet hours to end.
  const expired = !settings.pauseIndefinite && settings.pauseUntil !== null && nowMs >= settings.pauseUntil
  if (expired || (settings.pauseSummaryPending && !pauseActive(settings, nowMs))) {
    if (inQuietHours(now, deps.tz, settings.quietStart, settings.quietEnd)) {
      if (expired) {
        saveSettings({
          ...getSettings(),
          pauseUntil: null,
          pauseStartedAt: null,
          pauseIndefinite: false,
          pauseSummaryPending: true,
        })
        const vipRows = alertsByStatus('paused').filter((r) => r.vip)
        if (vipRows.length > 0) result.sent += await deliver(deps, vipRows)
      }
    } else {
      result.sent += await flushHeld(deps, 'pause_end')
    }
    settings = getSettings()
  }

  const paused = pauseActive(settings, nowMs)
  const quiet = inQuietHours(now, deps.tz, settings.quietStart, settings.quietEnd)

  // 2. Quiet hours are over and something is waiting.
  if (!paused && !quiet && alertsByStatus('held').length > 0) {
    result.sent += await flushHeld(deps, 'quiet_end')
  }

  // 2b. Failed sends, no header. VIPs go through quiet hours; a pause holds all.
  if (!paused) {
    const due = retrying.filter((r) => !quiet || r.vip)
    if (due.length > 0) result.sent += await sendEach(deps, due.slice(0, MAX_ALERTS_PER_SEND))
  }

  // 3. Read mail.
  const { boxes } = await deps.boxes()
  const vip = listAll('vip')
  const mute = listAll('mute')
  const criticals: Critical[] = []
  let boxFailures = 0
  let bodyFailures = 0

  for (const box of boxes) {
    try {
      const mails = await box.list(nowMs - LOOKBACK_MS)
      if (!getSettings().seededMailboxes.includes(box.id)) {
        for (const m of mails) markSeen(box.id, m.msgId, m.rfcMessageId)
        const fresh = getSettings()
        if (!fresh.seededMailboxes.includes(box.id)) {
          saveSettings({ ...fresh, seededMailboxes: [...fresh.seededMailboxes, box.id] })
        }
        continue
      }
      for (const m of mails) {
        if (!markSeen(box.id, m.msgId, m.rfcMessageId)) continue
        const decision = preDecide(m.headers, vip, mute)
        if (decision === 'mute' || decision === 'automated') continue
        if (decision === 'vip') {
          criticals.push({ mail: m, reason: VIP_REASON, vip: true })
          continue
        }
        let body: string
        try {
          body = await box.body(m.msgId)
        } catch {
          bodyFailures++
          continue
        }
        const outcome = await deps.triage({ from: m.headers.from, subject: m.subject, body })
        if (outcome.kind === 'capped') continue
        result.triaged++
        if (outcome.kind === 'verdict' && outcome.verdict.critical) {
          criticals.push({ mail: m, reason: outcome.verdict.reason, vip: false })
        }
      }
    } catch {
      boxFailures++
    }
  }
  if (boxFailures > 0 || bodyFailures > 0) {
    logger.warn({ boxFailures, bodyFailures }, 'email-alerts read failed')
  }

  // 4. Record, then deliver what is live. Oldest inserted first, so the
  // newest email has the highest id and leads every newest-first listing.
  criticals.sort((a, b) => a.mail.receivedAt - b.mail.receivedAt)
  const live: AlertRow[] = []
  for (const c of criticals) {
    const status: AlertStatus = paused ? 'paused' : quiet && !c.vip ? 'held' : 'sent'
    const row = {
      mailbox: c.mail.mailbox,
      msgId: c.mail.msgId,
      sender: c.mail.headers.from,
      subject: c.mail.subject,
      reason: c.reason,
      vip: c.vip,
      status,
      createdAt: nowMs,
    }
    const id = insertAlert(row)
    if (status === 'paused') result.paused++
    else if (status === 'held') result.held++
    else {
      live.push({ ...row, id, sentAt: null, chatId: null, chatMessageId: null, feedback: null, actions: [], attempts: 0 })
    }
  }
  if (live.length > 0) result.sent += await deliver(deps, live.reverse())

  // 5. One line, counts only.
  if (result.sent || result.held || result.paused || result.triaged) {
    logger.info(
      { sent: result.sent, held: result.held, paused: result.paused, triaged: result.triaged },
      'email-alerts tick'
    )
  }
  return result
}

/** First pass after 2 minutes, then every INTERVAL_MS. Never overlaps, never throws. */
export function startEmailAlerts(deps: TickDeps): () => void {
  let inFlight = false
  let stopped = false
  const run = async (): Promise<void> => {
    if (inFlight || stopped) return
    inFlight = true
    try {
      await tick(deps)
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'email-alerts tick failed')
    } finally {
      inFlight = false
    }
  }
  const first = setTimeout(() => void run(), FIRST_PASS_MS)
  const timer = setInterval(() => void run(), INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
