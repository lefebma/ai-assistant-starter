/**
 * Telegram during web setup: check the bot token, then find the owner's chat
 * by waiting for them to send /start (card #212), so nobody has to look up a
 * chat id.
 *
 * The rules that keep the wrong person from becoming the owner:
 * - only a private chat counts, never a group the bot was added to;
 * - only a /start sent after the page started waiting counts (everything
 *   already queued on the bot is skipped first);
 * - the page shows the sender's Telegram name and the owner confirms it, and
 *   "not me" ignores that chat and keeps waiting;
 * - waiting ends after ten minutes.
 */
export type Fetch = typeof fetch

const API = 'https://api.telegram.org'
export const PAIR_WINDOW_MS = 10 * 60 * 1000
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

export interface BotInfo {
  username: string
  firstName: string
}

export interface Candidate {
  chatId: number
  name: string
  username?: string
}

export class TelegramError extends Error {}

interface TgResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
}

interface TgUpdate {
  update_id: number
  message?: {
    date: number
    text?: string
    chat: { id: number; type: string; first_name?: string; last_name?: string; username?: string }
  }
}

async function call<T>(f: Fetch, token: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  let res: Response
  try {
    res = await f(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new TelegramError('Could not reach Telegram. Check the internet connection and try again.')
  }
  const body = (await res.json().catch(() => ({ ok: false }))) as TgResponse<T>
  if (body.ok && body.result !== undefined) return body.result
  if (body.error_code === 401 || body.error_code === 404) {
    throw new TelegramError('Telegram did not accept that token. Copy it again from BotFather, the whole line.')
  }
  if (body.error_code === 409) {
    throw new TelegramError(
      'This bot is already connected somewhere else (another assistant or a webhook). Make a new bot in BotFather for this assistant.'
    )
  }
  throw new TelegramError(`Telegram said: ${body.description ?? `error ${res.status}`}`)
}

export async function checkBotToken(f: Fetch, token: string): Promise<BotInfo> {
  const t = token.trim()
  if (!TOKEN_SHAPE.test(t)) {
    throw new TelegramError('That does not look like a bot token. It looks like 123456789:ABC... and BotFather sends it after /newbot.')
  }
  const me = await call<{ username?: string; first_name?: string; is_bot?: boolean }>(f, t, 'getMe')
  if (!me.is_bot || !me.username) throw new TelegramError('That token is not for a bot.')
  return { username: me.username, firstName: me.first_name ?? me.username }
}

export async function sendMessage(f: Fetch, token: string, chatId: number, text: string): Promise<void> {
  await call(f, token, 'sendMessage', { chat_id: chatId, text })
}

export type PairState =
  | { kind: 'waiting' }
  | { kind: 'found'; candidate: Candidate }
  | { kind: 'paired'; candidate: Candidate }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }

/**
 * One pairing attempt. `step()` makes a single getUpdates call; `run()` loops
 * it until something is found, it expires, or it is stopped. Kept as a step
 * so tests drive it without timers.
 */
export class Pairing {
  state: PairState = { kind: 'waiting' }
  private offset: number | null = null
  private readonly rejected = new Set<number>()
  private readonly startedAt: number
  private running = false
  private stopped = false

  constructor(
    private readonly f: Fetch,
    private readonly token: string,
    private readonly now: () => number = Date.now,
    private readonly pollSeconds = 20
  ) {
    this.startedAt = now()
  }

  /** Skip everything already queued, so an old /start cannot pair. */
  private async baseline(): Promise<void> {
    const pending = await call<TgUpdate[]>(this.f, this.token, 'getUpdates', { offset: -1, timeout: 0 })
    this.offset = pending.length ? pending[pending.length - 1]!.update_id + 1 : 0
  }

  async step(): Promise<void> {
    if (this.state.kind !== 'waiting') return
    if (this.now() - this.startedAt > PAIR_WINDOW_MS) {
      this.state = { kind: 'expired' }
      return
    }
    try {
      if (this.offset === null) await this.baseline()
      const updates = await call<TgUpdate[]>(
        this.f,
        this.token,
        'getUpdates',
        { offset: this.offset, timeout: this.pollSeconds, allowed_updates: ['message'] },
        (this.pollSeconds + 10) * 1000
      )
      for (const u of updates) {
        this.offset = u.update_id + 1
        const m = u.message
        if (!m || m.chat.type !== 'private' || !/^\/start(\s|@|$)/.test(m.text ?? '')) continue
        // Telegram dates are whole seconds; allow for that rounding.
        if (m.date * 1000 < this.startedAt - 1000) continue
        if (this.rejected.has(m.chat.id)) continue
        const name = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || 'Unknown'
        this.state = { kind: 'found', candidate: { chatId: m.chat.id, name, ...(m.chat.username ? { username: m.chat.username } : {}) } }
        return
      }
    } catch (err) {
      this.state = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Loop step() in the background until there is an answer. */
  run(): void {
    if (this.running) return
    this.running = true
    void (async () => {
      while (!this.stopped && this.state.kind === 'waiting') await this.step()
      this.running = false
    })()
  }

  /** The owner's answer to "is this you?". */
  async confirm(yes: boolean): Promise<void> {
    if (this.state.kind !== 'found') return
    const { candidate } = this.state
    if (!yes) {
      this.rejected.add(candidate.chatId)
      this.state = { kind: 'waiting' }
      this.run()
      return
    }
    this.state = { kind: 'paired', candidate }
    // Acknowledge what was read, so the assistant does not answer the /start
    // again on its first poll. Best effort: a repeat /start is harmless.
    try {
      await call(this.f, this.token, 'getUpdates', { offset: this.offset, timeout: 0 })
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.stopped = true
  }
}
