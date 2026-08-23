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
import { mapInbound, referenceFrom } from './activities.js'
import { InboundTokenValidator, OutboundTokenProvider } from './auth.js'
import { BotConnector } from './connector.js'
import {
  getConversation,
  hasProcessedActivity,
  initTeamsTables,
  markActivityProcessed,
  upsertConversation,
} from './conversations.js'
import type { Activity, ConversationReference, TeamsCredentials } from './types.js'

export const TEAMS_WEBHOOK_PATH = '/api/teams/messages'
const MAX_BODY_BYTES = 1_000_000
const AUTH_LOG_INTERVAL_MS = 60_000

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

  // --- Outbound (implemented in Task 10) ---

  async sendMessage(_chatId: string, _text: string, _options?: SendOptions): Promise<string> {
    throw new Error('not implemented')
  }
  async editMessage(_chatId: string, _messageId: string, _text: string, _options?: SendOptions): Promise<void> {
    throw new Error('not implemented')
  }
  async sendTyping(_chatId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async sendFile(_chatId: string, _filePath: string, _type: 'voice' | 'document'): Promise<void> {
    throw new Error('not implemented')
  }
  async answerCallback(_callbackId: string, _text?: string): Promise<void> {}
  async clearButtons(_chatId: string, _messageId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async deleteMessage(_chatId: string, _messageId: string): Promise<boolean> {
    return false
  }
  formatText(markdown: string): string {
    return markdown
  }
  splitMessage(text: string): string[] {
    return [text]
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
