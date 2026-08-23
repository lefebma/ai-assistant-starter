/**
 * Thin Bot Connector REST client. One retry per failure class; anything
 * else surfaces as ConnectorError so the bot logs it and moves on.
 */
import { logger } from '../../logger.js'
import type { FetchLike, OutboundTokenProvider } from './auth.js'
import type { ConversationReference, OutboundActivity } from './types.js'

export class ConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export interface ConnectorOptions {
  tokens: OutboundTokenProvider
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export class BotConnector {
  private readonly tokens: OutboundTokenProvider
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: ConnectorOptions) {
    this.tokens = opts.tokens
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async sendActivity(ref: ConversationReference, activity: OutboundActivity): Promise<string> {
    const json = await this.request('POST', activitiesUrl(ref), withReference(ref, activity))
    return (json as { id?: string })?.id ?? ''
  }

  async updateActivity(ref: ConversationReference, activityId: string, activity: OutboundActivity): Promise<void> {
    await this.request('PUT', activitiesUrl(ref, activityId), withReference(ref, activity))
  }

  async deleteActivity(ref: ConversationReference, activityId: string): Promise<void> {
    await this.request('DELETE', activitiesUrl(ref, activityId))
  }

  async sendTyping(ref: ConversationReference): Promise<void> {
    await this.request('POST', activitiesUrl(ref), withReference(ref, { type: 'typing' }))
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    let retried = { auth: false, throttle: false, server: false }
    for (;;) {
      const resp = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${await this.tokens.token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (resp.ok) {
        const text = await resp.text()
        return text ? JSON.parse(text) : undefined
      }
      if (resp.status === 401 && !retried.auth) {
        retried = { ...retried, auth: true }
        this.tokens.invalidate()
        continue
      }
      if (resp.status === 429 && !retried.throttle) {
        retried = { ...retried, throttle: true }
        const after = Number(resp.headers.get('Retry-After') ?? '1')
        await this.sleep((Number.isFinite(after) && after > 0 ? after : 1) * 1000)
        continue
      }
      if (resp.status >= 500 && !retried.server) {
        retried = { ...retried, server: true }
        await this.sleep(1000)
        continue
      }
      const detail = (await resp.text()).slice(0, 300)
      logger.warn({ status: resp.status, method, detail }, 'Teams: connector call failed')
      throw new ConnectorError(resp.status, `Bot Connector ${method} failed: ${resp.status} ${detail}`)
    }
  }
}

function activitiesUrl(ref: ConversationReference, activityId?: string): string {
  const base = `${ref.serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`
  return activityId ? `${base}/${encodeURIComponent(activityId)}` : base
}

function withReference(ref: ConversationReference, activity: OutboundActivity): Record<string, unknown> {
  return {
    ...activity,
    from: { id: ref.botId },
    recipient: { id: ref.userId },
    conversation: { id: ref.conversationId },
  }
}
