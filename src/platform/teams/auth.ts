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
      clockTolerance: 60,
      currentDate: this.now(),
    })
  }

  private async keys(refresh: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (this.keySet && !refresh) return this.keySet
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
    logger.debug({ keys: jwks.keys.length, refresh }, 'Teams: Bot Framework signing keys loaded')
    return this.keySet
  }
}
