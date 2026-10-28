import { describe, it, expect } from 'vitest'
import { googleProvider, microsoftProvider, googleRevoker, microsoftRevoker } from '../src/connect/providers.js'

const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'x@y.com' })).toString('base64url') + '.s'

describe('provider adapters (fake fetch)', () => {
  it('google exchange uses the client secret and reads the account from the id_token', async () => {
    let sent = ''
    const f = (async (_u: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 10, id_token: idToken }))
    }) as unknown as typeof fetch
    const t = await googleProvider({ clientId: 'cid', clientSecret: 'SECRET' }, f, () => 0).exchange('code', 'https://r/callback')
    expect(t).toEqual({ account: 'x@y.com', accessToken: 'a', refreshToken: 'r', expiresAt: 10_000 })
    expect(sent).toContain('client_secret=SECRET')
  })
  it('a provider error does not echo the response body', async () => {
    const f = (async () => new Response('leaky refresh_token=ZZZ', { status: 400 })) as unknown as typeof fetch
    await expect(microsoftProvider({ clientId: 'c', clientSecret: 's' }, f).exchange('c', 'u')).rejects.toThrow(/^token endpoint 400$/)
  })
  it('auth urls carry the state and never the client secret', () => {
    const u = googleProvider({ clientId: 'cid', clientSecret: 'SECRET' }).authUrl('ST', 'https://r/callback')
    expect(u).toContain('state=ST')
    expect(u).not.toContain('SECRET')
    expect(microsoftProvider({ clientId: 'cid', clientSecret: 'SECRET' }).authUrl('ST', 'u')).not.toContain('SECRET')
  })
  it('revokers throw when the provider does not confirm', async () => {
    const bad = (async () => new Response('', { status: 400 })) as unknown as typeof fetch
    await expect(googleRevoker(bad)({ accessToken: 'a', refreshToken: 'r' })).rejects.toThrow()
    await expect(microsoftRevoker(bad)({ accessToken: 'a', refreshToken: 'r' })).rejects.toThrow()
    const ok = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
    await expect(googleRevoker(ok)({ accessToken: 'a', refreshToken: 'r' })).resolves.toBeUndefined()
  })
})
