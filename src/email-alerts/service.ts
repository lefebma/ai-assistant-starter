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
 * nothing, so the whole flush is tried again next tick. An accepted header
 * moves its rows to `due`, so a flush cut short never repeats its header.
 *
 * A tick past TICK_CEILING_MS is abandoned: it stops at its next send, a send
 * it already started keeps that row or header out of later ticks until it
 * settles, and every held, retry or paused row is read again just before its
 * send. A duplicate is bounded to the one send already in flight.
 *
 * Log lines here carry counts only, never a subject, a sender or a mailbox.
 */
import { logger } from '../logger.js'
import {
  alertStatus,
  alertsByStatus,
  getSettings,
  insertAlert,
  isSeen,
  listAll,
  markAlertSent,
  markAlertSentQuiet,
  markAlertsDue,
  markSeen,
  recordSendFailure,
  saveSettings,
  type AlertRow,
  type AlertStatus,
} from './store.js'
import { inQuietHours, preDecide, senderAddress } from './rules.js'
import type { Mailbox, NewMail } from './sources.js'
import type { TriageInput, TriageOutcome } from './triage.js'
import {
  ALERT_BUTTONS,
  formatAlert,
  formatOverflow,
  pauseEndHeader,
  quietEndHeader,
  type FormatMode,
} from './format.js'

export const INTERVAL_MS = 10 * 60_000
export const MAX_ALERTS_PER_SEND = 5
/** A tick that runs longer than this stops holding the overlap guard, and is abandoned. */
export const TICK_CEILING_MS = 8 * 60_000
/**
 * A send an abandoned tick is still waiting on keeps its row or header out
 * of later ticks for at most this long (Slack retries for about 30 minutes).
 * Past it, a later tick may send it again rather than lose it.
 */
export const IN_FLIGHT_MAX_MS = 30 * 60_000
const FIRST_PASS_MS = 2 * 60_000
const LOOKBACK_MS = 2 * 86_400_000
const VIP_REASON = 'From a VIP'

export interface TickDeps {
  boxes: () => Promise<{ boxes: Mailbox[]; broken: { id: string; why: string }[] }>
  triage: (i: TriageInput) => Promise<TriageOutcome>
  send: (text: string, buttons?: string[]) => Promise<{ chatId: string; messageId: string } | null>
  now: () => Date
  tz: string
  /** How the adapter renders text. Telegram is `plain`; Teams and Slack are `markdown` (the default). */
  format?: FormatMode
}

export interface TickResult {
  sent: number
  held: number
  paused: number
  triaged: number
}

/** Rows and headers whose send has started and not yet settled, across ticks. */
export class InFlightSends {
  private readonly started = new Map<string, number>()
  has(key: string): boolean {
    const at = this.started.get(key)
    if (at === undefined) return false
    if (Date.now() - at >= IN_FLIGHT_MAX_MS) {
      this.started.delete(key)
      return false
    }
    return true
  }
  add(key: string): void {
    this.started.set(key, Date.now())
  }
  delete(key: string): void {
    this.started.delete(key)
  }
}

/**
 * What a tick shares with the loop that runs it. `abandoned` turns true once
 * the tick has run past TICK_CEILING_MS: from then on it sends nothing more,
 * and a later tick owns whatever it left.
 */
export interface TickControl {
  abandoned: () => boolean
  inFlight: InFlightSends
}

function standalone(): TickControl {
  return { abandoned: () => false, inFlight: new InFlightSends() }
}

/** Thrown at a send gate once the tick is abandoned; tick() catches it and stops. */
class Abandoned extends Error {}

interface Ctx {
  deps: TickDeps
  control: TickControl
}

interface Critical {
  mail: NewMail
  reason: string
  vip: boolean
}

const rowKey = (id: number): string => `row:${id}`

/**
 * Every send goes through here. An abandoned tick stops at the gate; a send
 * already started is still awaited, and its key stays in flight until it
 * settles so a later tick does not send the same thing alongside it.
 */
async function gatedSend(
  ctx: Ctx,
  key: string | null,
  text: string,
  buttons?: string[]
): Promise<{ chatId: string; messageId: string } | null> {
  if (ctx.control.abandoned()) throw new Abandoned()
  if (key) ctx.control.inFlight.add(key)
  try {
    return await ctx.deps.send(text, buttons)
  } catch {
    return null
  } finally {
    if (key) ctx.control.inFlight.delete(key)
  }
}

/** Counts a failed alert send; logs once per batch for any given up. */
function failSends(ids: number[]): void {
  let suppressed = 0
  for (const id of ids) if (recordSendFailure(id) === 'suppressed') suppressed++
  if (ids.length > 0) logger.warn({ failed: ids.length }, 'email-alerts send failed')
  if (suppressed > 0) logger.warn({ suppressed }, 'email-alerts gave up sending')
}

/** True when the row may still be sent: in one of `expect`, and not mid-send elsewhere. */
function stillDue(ctx: Ctx, row: AlertRow, expect: AlertStatus[] | undefined): boolean {
  if (ctx.control.inFlight.has(rowKey(row.id))) return false
  if (!expect) return true
  const now = alertStatus(row.id)
  return now !== null && expect.includes(now)
}

/**
 * One message per row, with buttons. Returns the number sent. With `expect`,
 * each row's status is read again just before its send, and a row another
 * tick already handled is skipped.
 */
async function sendEach(ctx: Ctx, rows: AlertRow[], expect?: AlertStatus[]): Promise<number> {
  let sent = 0
  const failed: number[] = []
  try {
    for (const row of rows) {
      if (ctx.control.abandoned()) throw new Abandoned()
      if (!stillDue(ctx, row, expect)) continue
      const res = await gatedSend(ctx, rowKey(row.id), formatAlert(row, ctx.deps.format), ALERT_BUTTONS)
      if (res) {
        markAlertSent(row.id, res.chatId, res.messageId, ctx.deps.now().getTime())
        sent++
      } else {
        failed.push(row.id)
      }
    }
  } finally {
    failSends(failed)
  }
  return sent
}

/**
 * Sends rows (already newest first): up to MAX_ALERTS_PER_SEND with buttons,
 * the rest recorded as sent behind one overflow line. Returns the number of
 * rows now recorded as sent.
 */
async function deliver(ctx: Ctx, rows: AlertRow[], expect?: AlertStatus[]): Promise<number> {
  let delivered = await sendEach(ctx, rows.slice(0, MAX_ALERTS_PER_SEND), expect)
  const rest = rows.slice(MAX_ALERTS_PER_SEND).filter((r) => stillDue(ctx, r, expect))
  if (rest.length > 0) {
    if (ctx.control.abandoned()) throw new Abandoned()
    const at = ctx.deps.now().getTime()
    for (const row of rest) markAlertSentQuiet(row.id, at)
    delivered += rest.length
    if (!(await gatedSend(ctx, null, formatOverflow(rest.length)))) {
      logger.warn({ failed: 1 }, 'email-alerts send failed')
    }
  }
  return delivered
}

function newestFirst(rows: AlertRow[]): AlertRow[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
}

function pauseActive(s: ReturnType<typeof getSettings>, nowMs: number): boolean {
  return s.pauseIndefinite || (s.pauseUntil !== null && nowMs < s.pauseUntil)
}

function pauseExpired(s: ReturnType<typeof getSettings>, nowMs: number): boolean {
  return !s.pauseIndefinite && s.pauseUntil !== null && nowMs >= s.pauseUntil
}

/** A pause has ended (now, or earlier during quiet hours) and its summary has not gone out. */
function pauseEndDue(s: ReturnType<typeof getSettings>, nowMs: number): boolean {
  return pauseExpired(s, nowMs) || (s.pauseSummaryPending && !pauseActive(s, nowMs))
}

/**
 * `pause_end`: the pause summary over paused and held rows. The pause is
 * cleared only once its header is accepted. `quiet_end`: rows held for quiet
 * hours, nothing at all when there are none.
 *
 * The condition is checked again right before the header goes out, and a
 * header still being sent by an abandoned tick is not sent again. Once the
 * header is accepted its rows move to `due`, so if this tick stops partway a
 * later one sends the rest without a second header.
 */
export async function flushHeld(
  deps: TickDeps,
  reason: 'quiet_end' | 'pause_end',
  control: TickControl = standalone()
): Promise<number> {
  return flush({ deps, control }, reason)
}

async function flush(ctx: Ctx, reason: 'quiet_end' | 'pause_end'): Promise<number> {
  const headerKey = `header:${reason}`
  if (ctx.control.inFlight.has(headerKey)) return 0
  const nowMs = ctx.deps.now().getTime()
  if (reason === 'pause_end' && !pauseEndDue(getSettings(), nowMs)) return 0
  const rows =
    reason === 'pause_end'
      ? newestFirst([...alertsByStatus('paused'), ...alertsByStatus('held')])
      : alertsByStatus('held')
  if (reason === 'quiet_end' && rows.length === 0) return 0
  const header = reason === 'pause_end' ? pauseEndHeader(rows.length) : quietEndHeader(rows.length)
  if (!(await gatedSend(ctx, headerKey, header))) {
    logger.warn({ failed: 1 }, 'email-alerts send failed')
    return 0
  }
  markAlertsDue(
    rows.map((r) => r.id),
    reason === 'pause_end' ? ['paused', 'held'] : ['held']
  )
  const at = ctx.deps.now().getTime()
  const fresh = getSettings()
  // Only the pause this header summarised is cleared: a new pause set while
  // the header was going out stays, and the rows wait (as `due`) for it.
  if (reason === 'pause_end' && pauseEndDue(fresh, at)) {
    saveSettings({
      ...fresh,
      pauseUntil: null,
      pauseStartedAt: null,
      pauseIndefinite: false,
      pauseSummaryPending: false,
    })
  } else if (pauseActive(fresh, at)) return 0
  if (rows.length === 0) return 0
  return deliver(ctx, rows, ['due'])
}

export async function tick(deps: TickDeps, control: TickControl = standalone()): Promise<TickResult> {
  const result: TickResult = { sent: 0, held: 0, paused: 0, triaged: 0 }
  try {
    await runTick({ deps, control }, result)
  } catch (err) {
    if (!(err instanceof Abandoned)) throw err
  }
  return result
}

async function runTick(ctx: Ctx, result: TickResult): Promise<void> {
  const { deps, control } = ctx
  let settings = getSettings()
  if (!settings.enabled) return

  const now = deps.now()
  const nowMs = now.getTime()

  // Retries are taken before this tick's flushes, so a send that fails in a
  // flush below waits a full interval before its next attempt.
  const retrying = alertsByStatus('retry')

  // 1. A timed pause that has run out ends here. During quiet hours its
  // VIPs go out at once and the summary waits for quiet hours to end.
  const expired = pauseExpired(settings, nowMs)
  if (pauseEndDue(settings, nowMs)) {
    if (inQuietHours(now, deps.tz, settings.quietStart, settings.quietEnd)) {
      if (expired) {
        saveSettings({
          ...getSettings(),
          pauseUntil: null,
          pauseStartedAt: null,
          pauseIndefinite: false,
          pauseSummaryPending: true,
        })
      }
      // Also picks up VIPs an abandoned tick did not get to.
      const vipRows = alertsByStatus('paused').filter((r) => r.vip)
      if (vipRows.length > 0) result.sent += await deliver(ctx, vipRows, ['paused'])
    } else {
      result.sent += await flush(ctx, 'pause_end')
    }
    settings = getSettings()
  }

  const paused = pauseActive(settings, nowMs)
  const quiet = inQuietHours(now, deps.tz, settings.quietStart, settings.quietEnd)

  // 2. Quiet hours are over and something is waiting. While a pause summary
  // is still owed, held rows belong to it, not to a second header.
  if (!paused && !quiet && !pauseEndDue(settings, nowMs) && alertsByStatus('held').length > 0) {
    result.sent += await flush(ctx, 'quiet_end')
  }

  // 2a. Rows whose header already went out, left by a tick that stopped partway.
  if (!paused) {
    const due = alertsByStatus('due')
    if (due.length > 0) result.sent += await deliver(ctx, due, ['due'])
  }

  // 2b. Failed sends, no header. VIPs go through quiet hours; a pause holds all.
  if (!paused) {
    const due = retrying.filter((r) => !quiet || r.vip)
    if (due.length > 0) result.sent += await sendEach(ctx, due.slice(0, MAX_ALERTS_PER_SEND), ['retry'])
  }

  // 3. Read mail. An abandoned tick stops before marking anything else seen,
  // so a later tick reads the rest.
  if (control.abandoned()) return
  const { boxes } = await deps.boxes()
  const vip = listAll('vip')
  const mute = listAll('mute')
  const criticals: Critical[] = []
  let boxFailures = 0
  let bodyFailures = 0

  for (const box of boxes) {
    if (control.abandoned()) break
    try {
      // Already-seen ids skip their per-message fetch; markSeen below still
      // catches the same email under another id (RFC Message-ID).
      const mails = await box.list(nowMs - LOOKBACK_MS, (id) => isSeen(box.id, id))
      if (!getSettings().seededMailboxes.includes(box.id)) {
        for (const m of mails) markSeen(box.id, m.msgId, m.rfcMessageId)
        const fresh = getSettings()
        if (!fresh.seededMailboxes.includes(box.id)) {
          saveSettings({ ...fresh, seededMailboxes: [...fresh.seededMailboxes, box.id] })
        }
        continue
      }
      const own = (box.address ?? box.id).trim().toLowerCase()
      for (const m of mails) {
        if (control.abandoned()) break
        if (!markSeen(box.id, m.msgId, m.rfcMessageId)) continue
        // The owner's own mail (a reply in a thread, a note to self) never alerts.
        if (senderAddress(m.headers.from) === own) continue
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
  // Mail this tick already marked seen is always recorded; if the tick was
  // abandoned meanwhile, what would have gone out now is left `due` for the
  // next tick instead.
  const stopped = control.abandoned()
  criticals.sort((a, b) => a.mail.receivedAt - b.mail.receivedAt)
  const live: AlertRow[] = []
  for (const c of criticals) {
    const status: AlertStatus = paused ? 'paused' : quiet && !c.vip ? 'held' : stopped ? 'due' : 'sent'
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
    else if (status === 'sent') {
      live.push({ ...row, id, sentAt: null, chatId: null, chatMessageId: null, feedback: null, actions: [], attempts: 0 })
    }
  }
  if (live.length > 0) result.sent += await deliver(ctx, live.reverse())

  // 5. One line, counts only.
  if (result.sent || result.held || result.paused || result.triaged) {
    logger.info(
      { sent: result.sent, held: result.held, paused: result.paused, triaged: result.triaged },
      'email-alerts tick'
    )
  }
}

/**
 * First pass after 2 minutes, then every INTERVAL_MS. Never overlaps, never
 * throws. A tick still running after TICK_CEILING_MS gives up the overlap
 * guard, so one hung call can never stop alerts for good, and is abandoned:
 * it sends nothing more once its current call returns.
 */
export function startEmailAlerts(deps: TickDeps): () => void {
  let inFlight = false
  let stopped = false
  const sends = new InFlightSends()
  const run = async (): Promise<void> => {
    if (inFlight || stopped) return
    inFlight = true
    let abandoned = false
    const control: TickControl = { abandoned: () => abandoned, inFlight: sends }
    let ceiling: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      ceiling = setTimeout(() => {
        abandoned = true
        resolve('timeout')
      }, TICK_CEILING_MS)
      ceiling.unref?.()
    })
    try {
      const outcome = await Promise.race([tick(deps, control).then(() => 'done' as const), timedOut])
      if (outcome === 'timeout') logger.warn({}, 'email-alerts tick timed out')
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'email-alerts tick failed')
    } finally {
      clearTimeout(ceiling)
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
