/**
 * Real provider adapters. Relay side: authUrl + exchange (Google's client
 * secret is passed in by the relay's own config and closed over here;
 * Microsoft has none). Box side: revokers, which need no client secret. Tests
 * drive them with a fake fetch. Not usable until the relay's /callback is
 * registered on the Google and Microsoft apps (cards 205/207).
 */
import { GrantRevokedError, type ProviderTokens, type RelayProvider } from './relay.js'
import type { Revoker } from './box.js'

export interface OAuthApp {
  clientId: string
  clientSecret: string
}

async function postForm(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  // Generic message on purpose: provider error bodies can echo request fields.
  if (!res.ok) throw new Error(`token endpoint ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

function toTokens(j: Record<string, unknown>, account: string, now: number): ProviderTokens {
  if (typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string') throw new Error('token response incomplete')
  return { account, accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 }
}

function emailFromIdToken(idToken: unknown): string {
  if (typeof idToken !== 'string') throw new Error('no id_token')
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  const e = claims.email ?? claims.preferred_username
  if (typeof e !== 'string') throw new Error('no account in id_token')
  return e
}

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar']
/**
 * The Graph scopes match the box's MS_SCOPES (src/ms/cli.ts) one for one, so
 * the box's own refresh asks for nothing the owner did not consent to here.
 * openid and email are on top, for the id_token that names the account.
 */
export const MICROSOFT_SCOPES = [
  'openid', 'email', 'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.ReadWrite',
]

export function googleProvider(app: OAuthApp, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): RelayProvider {
  return {
    authUrl: (state, redirectUri, codeChallenge) =>
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }),
    async exchange(code, redirectUri, codeVerifier) {
      const j = await postForm(fetchImpl, 'https://oauth2.googleapis.com/token', {
        code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier,
      })
      return toTokens(j, emailFromIdToken(j.id_token), now())
    },
    // Google ties a Web client's refresh token to its secret, so renewal runs here.
    async refresh(refreshToken) {
      const res = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      })
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
      // Only the error code is read, never echoed: the body can repeat request fields.
      if (j.error === 'invalid_grant') throw new GrantRevokedError()
      if (!res.ok || typeof j.access_token !== 'string') throw new Error(`token endpoint ${res.status}`)
      return {
        accessToken: j.access_token,
        expiresAt: now() + (Number(j.expires_in) || 3600) * 1000,
        ...(typeof j.refresh_token === 'string' ? { refreshToken: j.refresh_token } : {}),
      }
    },
  }
}

/**
 * Microsoft as a public client: no client secret, the code is bound to the
 * sign-in by PKCE. That is what lets the box refresh on its own with the
 * client id alone, exactly as it does after a device-code sign-in. Needs the
 * relay's /callback registered on the app under "Mobile and desktop
 * applications", not "Web" (a Web redirect makes the token endpoint demand a
 * secret).
 */
export function microsoftProvider(clientId: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): RelayProvider {
  return {
    authUrl: (state, redirectUri, codeChallenge) =>
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' +
      new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: MICROSOFT_SCOPES.join(' '),
        response_mode: 'query', prompt: 'select_account', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }),
    async exchange(code, redirectUri, codeVerifier) {
      const j = await postForm(fetchImpl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        code, client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', scope: MICROSOFT_SCOPES.join(' '), code_verifier: codeVerifier,
      })
      return toTokens(j, emailFromIdToken(j.id_token), now())
    },
  }
}

/** Google revokes by token and needs no client secret. */
export function googleRevoker(fetchImpl: typeof fetch = fetch): Revoker {
  return async ({ refreshToken }) => {
    const res = await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    })
    if (!res.ok) throw new Error(`revoke ${res.status}`)
  }
}

/** Microsoft has no token revoke endpoint; this invalidates the account's refresh tokens via Graph. */
export function microsoftRevoker(fetchImpl: typeof fetch = fetch): Revoker {
  return async ({ accessToken }) => {
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/revokeSignInSessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`revoke ${res.status}`)
  }
}
