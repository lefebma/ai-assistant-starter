import { describe, it, expect } from 'vitest'
import {
  resolveMsConfig,
  DEFAULT_MS_CLIENT_ID,
  stampExpiry,
  needsRefresh,
  startDeviceCode,
  pollDeviceCode,
  refreshTokens,
  REFRESH_MARGIN_SECS,
  type MsTokens,
} from '../src/ms/auth.js'

const CFG = { clientId: 'cid', tenantId: 'common' }

function jsonFetch(status: number, body: unknown) {
  const calls: { url: string; body: string }[] = []
  const fn = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ?? '' })
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fn: fn as never, calls }
}

describe('resolveMsConfig', () => {
  it('uses the built-in registration when none is configured, so Outlook works out of the box', () => {
    expect(resolveMsConfig({}).clientId).toBe(DEFAULT_MS_CLIENT_ID)
    expect(resolveMsConfig({ MS_CLIENT_ID: '   ' }).clientId).toBe(DEFAULT_MS_CLIENT_ID)
  })

  it('lets MS_CLIENT_ID replace it, for anyone shipping under their own name', () => {
    expect(resolveMsConfig({ MS_CLIENT_ID: 'mine' }).clientId).toBe('mine')
  })

  it('never ships a blank or malformed default', () => {
    expect(DEFAULT_MS_CLIENT_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('defaults the tenant to common, which is what makes it work for any org', () => {
    expect(resolveMsConfig({ MS_CLIENT_ID: 'x' })).toEqual({ clientId: 'x', tenantId: 'common' })
  })

  it('lets a tenant be pinned for an org that refuses a multi-tenant app', () => {
    expect(resolveMsConfig({ MS_CLIENT_ID: 'x', MS_TENANT_ID: 'contoso.onmicrosoft.com' })).toEqual({
      clientId: 'x',
      tenantId: 'contoso.onmicrosoft.com',
    })
  })

  it('ignores blank values rather than treating them as set', () => {
    expect(resolveMsConfig({ MS_CLIENT_ID: 'x', MS_TENANT_ID: '   ' }).tenantId).toBe('common')
  })
})

describe('stampExpiry', () => {
  it('turns a relative expires_in into an absolute time', () => {
    const t = stampExpiry({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 1_000_000)
    expect(t.expiresAt).toBe(1_000_000 + 3600)
    expect(t.accessToken).toBe('a')
    expect(t.refreshToken).toBe('r')
  })

  it('keeps the old refresh token when the response omits one', () => {
    // Microsoft usually returns a new refresh token, but not always. Writing
    // the raw response over the cache would drop it and force a full
    // re-authentication on the next call.
    const t = stampExpiry({ access_token: 'a2', expires_in: 3600 }, 0, 'old-refresh')
    expect(t.refreshToken).toBe('old-refresh')
  })
})

describe('needsRefresh', () => {
  const tok = (expiresAt: number): MsTokens => ({ accessToken: 'a', refreshToken: 'r', expiresAt })

  it('is false for a token with plenty of life left', () => {
    expect(needsRefresh(tok(1000 + REFRESH_MARGIN_SECS + 60), 1000)).toBe(false)
  })

  it('is true once inside the safety margin', () => {
    expect(needsRefresh(tok(1000 + REFRESH_MARGIN_SECS - 1), 1000)).toBe(true)
  })

  it('is true for an expired token', () => {
    expect(needsRefresh(tok(500), 1000)).toBe(true)
  })

  it('is true when there is no token at all', () => {
    expect(needsRefresh(null, 1000)).toBe(true)
  })
})

describe('startDeviceCode', () => {
  it('asks Microsoft for a code and returns what the person has to do', async () => {
    const { fn, calls } = jsonFetch(200, {
      verification_uri: 'https://microsoft.com/devicelogin',
      user_code: 'ABCD-EFGH',
      device_code: 'dev',
      interval: 5,
      expires_in: 900,
    })
    const out = await startDeviceCode(CFG, 'Mail.Read', fn)
    expect(out).toMatchObject({ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD-EFGH', deviceCode: 'dev', intervalSecs: 5 })
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode')
    expect(calls[0]!.body).toContain('client_id=cid')
  })

  it('never sends a client secret, because this is a public client', async () => {
    const { fn, calls } = jsonFetch(200, { verification_uri: 'u', user_code: 'c', device_code: 'd', interval: 5, expires_in: 900 })
    await startDeviceCode(CFG, 'Mail.Read', fn)
    expect(calls[0]!.body).not.toContain('client_secret')
  })

  it('surfaces a refusal rather than hanging', async () => {
    const { fn } = jsonFetch(400, { error: 'unauthorized_client', error_description: 'not allowed' })
    await expect(startDeviceCode(CFG, 'Mail.Read', fn)).rejects.toThrow(/not allowed/)
  })
})

describe('pollDeviceCode', () => {
  it('reports pending while the person has not finished', async () => {
    const { fn } = jsonFetch(400, { error: 'authorization_pending' })
    expect(await pollDeviceCode(CFG, 'dev', fn, 0)).toEqual({ status: 'pending' })
  })

  it('reports slow_down as pending, flagged so the caller widens its interval', async () => {
    const { fn } = jsonFetch(400, { error: 'slow_down' })
    expect(await pollDeviceCode(CFG, 'dev', fn, 0)).toEqual({ status: 'pending', slowDown: true })
  })

  it('returns stamped tokens on success', async () => {
    const { fn } = jsonFetch(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    const out = await pollDeviceCode(CFG, 'dev', fn, 1_000)
    expect(out.status).toBe('ok')
    if (out.status === 'ok') expect(out.tokens).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 4_600 })
  })

  it('reports a real failure as failed, not pending', async () => {
    const { fn } = jsonFetch(400, { error: 'expired_token', error_description: 'code expired' })
    const out = await pollDeviceCode(CFG, 'dev', fn, 0)
    expect(out).toMatchObject({ status: 'failed' })
  })
})

describe('refreshTokens', () => {
  it('exchanges a refresh token and stamps the new expiry', async () => {
    const { fn, calls } = jsonFetch(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    const out = await refreshTokens(CFG, 'Mail.Read', 'r1', fn, 100)
    expect(out).toEqual({ accessToken: 'a2', refreshToken: 'r2', expiresAt: 3_700 })
    expect(calls[0]!.body).toContain('grant_type=refresh_token')
  })

  it('carries the old refresh token forward when none comes back', async () => {
    const { fn } = jsonFetch(200, { access_token: 'a2', expires_in: 3600 })
    expect((await refreshTokens(CFG, 'Mail.Read', 'r1', fn, 0)).refreshToken).toBe('r1')
  })

  it('throws on a revoked grant so the caller can re-authenticate', async () => {
    const { fn } = jsonFetch(400, { error: 'invalid_grant', error_description: 'revoked' })
    await expect(refreshTokens(CFG, 'Mail.Read', 'r1', fn, 0)).rejects.toThrow(/revoked/)
  })
})
