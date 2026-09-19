/**
 * Microsoft identity: device code in, refreshed access tokens out.
 *
 * Ported from the five outlook-*.js scripts that have run this assistant's
 * Outlook access across three tenants since January, rather than written
 * fresh against the docs. The flow those scripts use is the right one for
 * this product: device code needs no redirect URI and no browser on the
 * machine, which is what a headless VPS has.
 *
 * Two things are deliberately not ports:
 *
 * 1. **Expiry is absolute.** The originals call refresh before every single
 *    Graph request, because they store Microsoft's raw response and its
 *    `expires_in` is relative, so there is nothing to compare a clock to.
 *    That is a round trip to login.microsoftonline.com per operation and a
 *    token endpoint is a rate-limited thing to lean on. Here the expiry is
 *    stamped at issue and refresh happens only inside the margin.
 * 2. **A refresh keeps the old refresh token when the response omits one.**
 *    The originals write the raw response over the cache. Microsoft usually
 *    returns a new refresh token, but on the occasion it does not, that write
 *    drops it and the next call has to send the owner through device code
 *    again.
 *
 * No client secret appears anywhere: this is a public client, and the device
 * code grant for one is not supposed to have a secret. Nothing to store, and
 * nothing to leak.
 */

const LOGIN_HOST = 'https://login.microsoftonline.com'

/** Refresh this far ahead of expiry, so a slow call cannot land on a dead token. */
export const REFRESH_MARGIN_SECS = 300

export interface MsConfig {
  clientId: string
  /** 'common' lets any Microsoft organization sign in; pin it for one tenant. */
  tenantId: string
}

export interface MsTokens {
  accessToken: string
  refreshToken: string
  /** Epoch seconds. */
  expiresAt: number
}

/** Microsoft's raw token response. */
interface RawToken {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>

export function resolveMsConfig(env: Record<string, string | undefined>): MsConfig {
  const clientId = (env['MS_CLIENT_ID'] ?? '').trim()
  if (!clientId) {
    throw new Error('MS_CLIENT_ID is not set. Outlook needs a Microsoft app registration id.')
  }
  const tenantId = (env['MS_TENANT_ID'] ?? '').trim() || 'common'
  return { clientId, tenantId }
}

/** Absolute expiry, plus the old refresh token when the response carried none. */
export function stampExpiry(raw: RawToken, nowSecs: number, previousRefresh = ''): MsTokens {
  return {
    accessToken: raw.access_token ?? '',
    refreshToken: raw.refresh_token ?? previousRefresh,
    expiresAt: nowSecs + (raw.expires_in ?? 0),
  }
}

export function needsRefresh(tokens: MsTokens | null, nowSecs: number): boolean {
  if (!tokens) return true
  return tokens.expiresAt - nowSecs <= REFRESH_MARGIN_SECS
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
}

async function post(url: string, body: string, fetchImpl: FetchLike): Promise<RawToken> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  return (await res.json()) as RawToken
}

export interface DeviceCodeStart {
  /** Where the person goes, e.g. https://microsoft.com/devicelogin */
  verificationUri: string
  /** What they type there. */
  userCode: string
  /** Opaque handle for polling; never shown to anyone. */
  deviceCode: string
  intervalSecs: number
  expiresInSecs: number
}

export async function startDeviceCode(
  cfg: MsConfig,
  scopes: string,
  fetchImpl: FetchLike
): Promise<DeviceCodeStart> {
  const raw = (await post(
    `${LOGIN_HOST}/${cfg.tenantId}/oauth2/v2.0/devicecode`,
    form({ client_id: cfg.clientId, scope: scopes }),
    fetchImpl
  )) as RawToken & {
    verification_uri?: string
    user_code?: string
    device_code?: string
    interval?: number
  }
  if (raw.error || !raw.device_code) {
    throw new Error(raw.error_description || raw.error || 'Microsoft refused the device code request')
  }
  return {
    verificationUri: raw.verification_uri ?? 'https://microsoft.com/devicelogin',
    userCode: raw.user_code ?? '',
    deviceCode: raw.device_code,
    intervalSecs: raw.interval ?? 5,
    expiresInSecs: raw.expires_in ?? 900,
  }
}

export type PollResult =
  | { status: 'pending'; slowDown?: true }
  | { status: 'ok'; tokens: MsTokens }
  | { status: 'failed'; reason: string }

/**
 * One poll. 'authorization_pending' and 'slow_down' both mean keep waiting;
 * anything else is over, and saying so beats polling a dead code for
 * fifteen minutes.
 */
export async function pollDeviceCode(
  cfg: MsConfig,
  deviceCode: string,
  fetchImpl: FetchLike,
  nowSecs: number
): Promise<PollResult> {
  const raw = await post(
    `${LOGIN_HOST}/${cfg.tenantId}/oauth2/v2.0/token`,
    form({
      client_id: cfg.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }),
    fetchImpl
  )
  if (raw.access_token) return { status: 'ok', tokens: stampExpiry(raw, nowSecs) }
  if (raw.error === 'authorization_pending') return { status: 'pending' }
  // RFC 8628: slow_down means add five seconds to the interval, for good.
  if (raw.error === 'slow_down') return { status: 'pending', slowDown: true }
  return { status: 'failed', reason: raw.error_description || raw.error || 'device code failed' }
}

export async function refreshTokens(
  cfg: MsConfig,
  scopes: string,
  refreshToken: string,
  fetchImpl: FetchLike,
  nowSecs: number
): Promise<MsTokens> {
  const raw = await post(
    `${LOGIN_HOST}/${cfg.tenantId}/oauth2/v2.0/token`,
    form({
      client_id: cfg.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes,
    }),
    fetchImpl
  )
  if (!raw.access_token) {
    throw new Error(raw.error_description || raw.error || 'Token refresh failed')
  }
  return stampExpiry(raw, nowSecs, refreshToken)
}
