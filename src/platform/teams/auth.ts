/**
 * Bot Framework authentication, both directions.
 *
 * Inbound: Microsoft signs each POST with a JWT issued by
 * api.botframework.com for our app id. We verify signature, issuer,
 * audience, and expiry against the JWKS the OpenID configuration points at.
 *
 * Outbound (Task 6): client-credentials token for the Bot Connector REST API.
 *
 * Network access is through an injected fetch so tests stay offline.
 */
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet } from 'jose'
import { logger } from '../../logger.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const BOT_FRAMEWORK_OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com'

export interface InboundValidatorOptions {
  appId: string
  fetchImpl?: FetchLike
  now?: () => Date
  openIdConfigUrl?: string
}

export class InboundTokenValidator {
  private readonly appId: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => Date
  private readonly openIdConfigUrl: string
  private jwksUri: string | null = null
  private keySet: ReturnType<typeof createLocalJWKSet> | null = null
  private lastRefetchAt = -Infinity
  private inflight: Promise<ReturnType<typeof createLocalJWKSet>> | null = null

  constructor(opts: InboundValidatorOptions) {
    this.appId = opts.appId
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => new Date())
    this.openIdConfigUrl = opts.openIdConfigUrl ?? BOT_FRAMEWORK_OPENID_URL
  }

  async validate(authorizationHeader: string | undefined): Promise<boolean> {
    const token = authorizationHeader?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (!token) return false
    try {
      await this.verify(token, await this.keys(false))
      return true
    } catch (err) {
      if (err instanceof joseErrors.JWKSNoMatchingKey) {
        // Key rotation: fetch the set once more, then give up.
        try {
          await this.verify(token, await this.keys(true))
          return true
        } catch {
          return false
        }
      }
      return false
    }
  }

  private async verify(token: string, keySet: ReturnType<typeof createLocalJWKSet>): Promise<void> {
    await jwtVerify(token, keySet, {
      issuer: BOT_FRAMEWORK_ISSUER,
      audience: this.appId,
      algorithms: ['RS256'],
      clockTolerance: 60,
      currentDate: this.now(),
    })
  }

  /**
   * `refresh` is only requested after an unknown kid (possible key rotation).
   * Cap those rotation refetches to once per 60s and share one in-flight
   * fetch across concurrent callers, so a burst of requests signed with an
   * unrecognised kid can't be used to hammer Microsoft's JWKS endpoint.
   * The first (cold) load is never capped.
   */
  private async keys(refresh: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.keySet && !refresh) return this.keySet
    if (refresh && this.keySet && this.now().getTime() - this.lastRefetchAt < 60_000) {
      return this.keySet
    }
    if (this.inflight) return this.inflight
    this.inflight = this.load(refresh).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async load(refresh: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!this.jwksUri) {
      const resp = await this.fetchImpl(this.openIdConfigUrl)
      if (!resp.ok) throw new Error(`OpenID configuration fetch failed: ${resp.status}`)
      const cfg = (await resp.json()) as { jwks_uri?: string }
      if (!cfg.jwks_uri) throw new Error('OpenID configuration has no jwks_uri')
      this.jwksUri = cfg.jwks_uri
    }
    const resp = await this.fetchImpl(this.jwksUri)
    if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`)
    const jwks = (await resp.json()) as JSONWebKeySet
    this.keySet = createLocalJWKSet(jwks)
    if (refresh) this.lastRefetchAt = this.now().getTime()
    logger.debug({ keys: jwks.keys.length, refresh }, 'Teams: Bot Framework signing keys loaded')
    return this.keySet
  }
}

export interface OutboundTokenOptions {
  appId: string
  appSecret: string
  tenantId?: string
  fetchImpl?: FetchLike
  now?: () => number
}

const REFRESH_MARGIN_MS = 300_000

export class OutboundTokenProvider {
  private readonly opts: OutboundTokenOptions
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private cached: { token: string; expiresAt: number } | null = null
  private inflight: Promise<string> | null = null

  constructor(opts: OutboundTokenOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => Date.now())
  }

  static tokenUrl(tenantId?: string): string {
    return `https://login.microsoftonline.com/${tenantId ?? 'botframework.com'}/oauth2/v2.0/token`
  }

  invalidate(): void {
    this.cached = null
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.cached.token
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.appId,
      client_secret: this.opts.appSecret,
      scope: 'https://api.botframework.com/.default',
    })
    const resp = await this.fetchImpl(OutboundTokenProvider.tokenUrl(this.opts.tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!resp.ok) {
      // Body may describe the failure; it never contains our secret.
      const detail = (await resp.text()).slice(0, 200)
      throw new Error(`Bot Framework token request failed: ${resp.status} ${detail}`)
    }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new Error('Bot Framework token response had no access_token')
    this.cached = { token: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 }
    return this.cached.token
  }
}
