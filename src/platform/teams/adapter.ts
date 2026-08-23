/**
 * Microsoft Teams platform adapter (1:1 personal chat).
 *
 * Inbound: Microsoft POSTs activities to /api/teams/messages on the app's
 * own HTTP server (Caddy proxies exactly that path from 443). We verify the
 * Bot Framework JWT, answer 200 right away, and process asynchronously.
 * Outbound: Bot Connector REST calls using the conversation reference stored
 * on the last inbound activity, so scheduled/proactive sends work.
 *
 * Every collaborator is injectable so the unit tests run without a network,
 * a database directory, or a listening socket.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http'
import { registerHttpRoute } from '../../http-server.js'
import { logger } from '../../logger.js'
import { downloadToUploads } from '../../media.js'
import type { PlatformAdapter, IncomingMessage, SendOptions } from '../types.js'
import { basename } from 'node:path'
import { buildCardActivity, buildClearedCardActivity, buildTextActivity, formatForTeams, mapInbound, referenceFrom } from './activities.js'
import { InboundTokenValidator, OutboundTokenProvider } from './auth.js'
import { BotConnector } from './connector.js'
import {
  getConversation,
  hasProcessedActivity,
  initTeamsTables,
  markActivityProcessed,
  upsertConversation,
} from './conversations.js'
import type { Activity, ConversationReference, OutboundActivity, TeamsCredentials } from './types.js'

export const TEAMS_WEBHOOK_PATH = '/api/teams/messages'
const MAX_BODY_BYTES = 1_000_000
const AUTH_LOG_INTERVAL_MS = 60_000
const EDIT_INTERVAL_MS = 1000

export interface TeamsAdapterOptions extends TeamsCredentials {
  validator?: Pick<InboundTokenValidator, 'validate'>
  connector?: Pick<BotConnector, 'sendActivity' | 'updateActivity' | 'deleteActivity' | 'sendTyping'>
  tokens?: OutboundTokenProvider
  download?: typeof downloadToUploads
  registerRoute?: typeof registerHttpRoute
  now?: () => number
}

export class TeamsAdapter implements PlatformAdapter {
  readonly name = 'teams' as const
  readonly maxMessageLength = 8000
  readonly supportsEdit = true
  readonly supportsButtons = true

  private readonly appId: string
  private readonly validator: Pick<InboundTokenValidator, 'validate'>
  private readonly connector: Pick<BotConnector, 'sendActivity' | 'updateActivity' | 'deleteActivity' | 'sendTyping'>
  private readonly tokens: OutboundTokenProvider
  private readonly download: typeof downloadToUploads
  private readonly registerRoute: typeof registerHttpRoute
  private readonly now: () => number
  private unregister: (() => void) | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private activityHandler: (() => void) | null = null
  private authFailures = { lastLoggedAt: 0, suppressed: 0 }
  private cardTexts = new Map<string, string>()
  private edits = new Map<string, { lastSentAt: number; pending?: { activityId: string; activity: OutboundActivity }; timer?: NodeJS.Timeout }>()

  constructor(opts: TeamsAdapterOptions) {
    this.appId = opts.appId
    this.now = opts.now ?? (() => Date.now())
    this.tokens = opts.tokens ?? new OutboundTokenProvider({ appId: opts.appId, appSecret: opts.appSecret, tenantId: opts.tenantId })
    this.validator = opts.validator ?? new InboundTokenValidator({ appId: opts.appId })
    this.connector = opts.connector ?? new BotConnector({ tokens: this.tokens })
    this.download = opts.download ?? downloadToUploads
    this.registerRoute = opts.registerRoute ?? registerHttpRoute
    // Tables exist from construction so processActivity works in tests that
    // never call start(); CREATE IF NOT EXISTS makes this idempotent.
    initTeamsTables()
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.unregister = this.registerRoute('POST', TEAMS_WEBHOOK_PATH, (req, res) => this.handleRequest(req, res))
    logger.info({ path: TEAMS_WEBHOOK_PATH }, 'Teams adapter started (webhook registered)')
  }

  async stop(): Promise<void> {
    this.unregister?.()
    this.unregister = null
    this.tokens.invalidate()
  }

  // --- Events ---

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onActivity(handler: () => void): void {
    this.activityHandler = handler
  }

  // --- Inbound ---

  async handleRequest(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (!(await this.validator.validate(req.headers.authorization))) {
      this.logAuthFailure()
      res.writeHead(401)
      res.end()
      return
    }
    let body: string
    try {
      body = await readBodyLimited(req, MAX_BODY_BYTES)
    } catch {
      res.writeHead(413)
      res.end()
      return
    }
    let activity: Activity
    try {
      activity = JSON.parse(body) as Activity
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    res.writeHead(200)
    res.end()
    void this.processActivity(activity).catch((err) => {
      logger.error({ err, activityId: activity.id, type: activity.type }, 'Teams: failed to process activity')
    })
  }

  async processActivity(activity: Activity): Promise<void> {
    this.activityHandler?.()
    if (activity.id) {
      if (hasProcessedActivity(activity.id)) {
        logger.debug({ activityId: activity.id }, 'Teams: duplicate activity ignored')
        return
      }
      markActivityProcessed(activity.id)
    }
    const ref = referenceFrom(activity)
    if (ref) upsertConversation(ref)

    const botId = activity.recipient?.id ?? `28:${this.appId}`
    const mapped = mapInbound(activity, botId)
    switch (mapped.kind) {
      case 'message':
        await this.messageHandler?.(mapped.message)
        return
      case 'attachment': {
        const headers = mapped.download.needsAuth ? { Authorization: `Bearer ${await this.tokens.token()}` } : undefined
        const filePath = await this.download(mapped.download.url, mapped.download.name, headers)
        await this.messageHandler?.({ ...mapped.base, filePath })
        return
      }
      case 'bot-added':
        if (ref) await this.messageHandler?.({ chatId: ref.conversationId, userId: ref.userId, text: '/chatid', type: 'text' })
        return
      case 'ignore':
        logger.debug({ reason: mapped.reason, type: activity.type }, 'Teams: activity ignored')
        return
    }
  }

  private logAuthFailure(): void {
    const t = this.now()
    if (t - this.authFailures.lastLoggedAt >= AUTH_LOG_INTERVAL_MS) {
      logger.warn({ suppressedSinceLast: this.authFailures.suppressed }, 'Teams: rejected request with invalid Bot Framework token')
      this.authFailures = { lastLoggedAt: t, suppressed: 0 }
    } else {
      this.authFailures.suppressed++
    }
  }

  protected reference(chatId: string): ConversationReference {
    const ref = getConversation(chatId)
    if (!ref) throw new Error(`Teams: no conversation reference for ${chatId}; the user has to message the bot first`)
    return ref
  }

  // --- Outbound ---

  async sendMessage(chatId: string, text: string, options?: SendOptions): Promise<string> {
    const ref = this.reference(chatId)
    const buttons = options?.buttons?.filter((b) => b.trim()) ?? []
    const activity = buttons.length ? buildCardActivity(text, buttons) : buildTextActivity(text)
    const id = await this.connector.sendActivity(ref, activity)
    if (buttons.length && id) this.cardTexts.set(id, text)
    return id
  }

  /**
   * Teams throttles bots well below Telegram's edit rate. One PUT per second
   * per conversation; edits inside the window are coalesced and the latest
   * text goes out when the window closes.
   */
  async editMessage(chatId: string, messageId: string, text: string, options?: SendOptions): Promise<void> {
    const ref = this.reference(chatId)
    const buttons = options?.buttons?.filter((b) => b.trim()) ?? []
    const activity = buttons.length ? buildCardActivity(text, buttons) : buildTextActivity(text)
    if (buttons.length) this.cardTexts.set(messageId, text)
    const state = this.edits.get(chatId) ?? { lastSentAt: 0 }
    this.edits.set(chatId, state)
    const elapsed = this.now() - state.lastSentAt
    if (elapsed >= EDIT_INTERVAL_MS && !state.timer) {
      state.lastSentAt = this.now()
      await this.connector.updateActivity(ref, messageId, activity)
      return
    }
    state.pending = { activityId: messageId, activity }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        const pending = state.pending
        state.pending = undefined
        if (!pending) return
        state.lastSentAt = this.now()
        this.connector.updateActivity(ref, pending.activityId, pending.activity).catch((err) => {
          logger.warn({ err, chatId }, 'Teams: coalesced edit failed')
        })
      }, Math.max(0, EDIT_INTERVAL_MS - elapsed))
      state.timer.unref?.()
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.connector.sendTyping(this.reference(chatId))
  }

  async sendFile(chatId: string, filePath: string, _type: 'voice' | 'document'): Promise<void> {
    await this.sendMessage(
      chatId,
      `Saved on the assistant's machine as ${basename(filePath)}. Sending files into Teams is not supported yet.`
    )
  }

  async answerCallback(_callbackId: string, _text?: string): Promise<void> {
    // messageBack clicks arrive as ordinary messages; nothing to acknowledge.
  }

  async clearButtons(chatId: string, messageId: string): Promise<void> {
    const text = this.cardTexts.get(messageId)
    if (text === undefined) {
      logger.debug({ messageId }, 'Teams: no remembered card to clear (restarted since it was sent?)')
      return
    }
    await this.connector.updateActivity(this.reference(chatId), messageId, buildClearedCardActivity(text))
    this.cardTexts.delete(messageId)
  }

  async deleteMessage(_chatId: string, _messageId: string): Promise<boolean> {
    // Bots cannot delete a user's message in Teams; the caller tells the user.
    return false
  }

  formatText(markdown: string): string {
    return formatForTeams(markdown)
  }

  splitMessage(text: string): string[] {
    const limit = this.maxMessageLength
    if (text.length <= limit) return [text]
    const chunks: string[] = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', limit)
      if (splitAt === -1 || splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit)
      if (splitAt === -1 || splitAt < limit * 0.5) splitAt = limit
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).replace(/^[ \n]/, '')
    }
    return chunks
  }
}

function readBodyLimited(req: HttpRequest, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
