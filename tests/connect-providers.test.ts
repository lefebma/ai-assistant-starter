import { describe, it, expect } from 'vitest'
import { googleProvider, microsoftProvider, MICROSOFT_SCOPES } from '../src/connect/providers.js'
import { MS_SCOPES } from '../src/ms/cli.js'
import { GrantRevokedError } from '../src/connect/relay.js'

const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'x@y.com' })).toString('base64url') + '.s'

describe('provider adapters (fake fetch)', () => {
  it('google exchange uses the client secret and reads the account from the id_token', async () => {
    let sent = ''
    const f = (async (_u: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 10, id_token: idToken }))
    }) as unknown as typeof fetch
    const t = await googleProvider({ clientId: 'cid', clientSecret: 'SECRET' }, f, () => 0).exchange('code', 'https://r/callback', 'VERIFIER')
    expect(t).toEqual({ account: 'x@y.com', accessToken: 'a', refreshToken: 'r', expiresAt: 10_000 })
    expect(sent).toContain('client_secret=SECRET')
    expect(sent).toContain('code_verifier=VERIFIER')
  })
  it('microsoft exchange is a public client: PKCE verifier, no client secret', async () => {
    let sent = ''
    const f = (async (_u: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 10, id_token: idToken }))
    }) as unknown as typeof fetch
    const t = await microsoftProvider('cid', f, () => 0).exchange('code', 'https://r/callback', 'VERIFIER')
    expect(t.account).toBe('x@y.com')
    expect(sent).toContain('code_verifier=VERIFIER')
    expect(sent).not.toContain('client_secret')
  })
  it('a provider error does not echo the response body', async () => {
    const f = (async () => new Response('leaky refresh_token=ZZZ', { status: 400 })) as unknown as typeof fetch
    await expect(microsoftProvider('c', f).exchange('c', 'u', 'v')).rejects.toThrow(/^token endpoint 400$/)
  })
  it('auth urls carry the state and an S256 challenge, never the client secret', () => {
    const u = new URL(googleProvider({ clientId: 'cid', clientSecret: 'SECRET' }).authUrl('ST', 'https://r/callback', 'CH'))
    expect(u.searchParams.get('state')).toBe('ST')
    expect(u.searchParams.get('code_challenge')).toBe('CH')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.toString()).not.toContain('SECRET')
    const m = new URL(microsoftProvider('cid').authUrl('ST', 'u', 'CH'))
    expect(m.searchParams.get('code_challenge_method')).toBe('S256')
  })
  it('asks Microsoft for every scope the box refreshes with', () => {
    for (const s of MS_SCOPES.split(' ')) expect(MICROSOFT_SCOPES).toContain(s)
  })
  it('google renewal sends the secret, returns the new token, and maps invalid_grant without echoing the body', async () => {
    let sent = ''
    const ok = (async (_u: string, init: RequestInit) => {
      sent = String(init.body)
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 100 }))
    }) as unknown as typeof fetch
    const g = googleProvider({ clientId: 'cid', clientSecret: 'SECRET' }, ok, () => 0)
    expect(await g.refresh!('RT')).toEqual({ accessToken: 'new', expiresAt: 100_000 })
    expect(sent).toContain('grant_type=refresh_token')
    expect(sent).toContain('client_secret=SECRET')
    const revoked = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'echo RT' }), { status: 400 })) as unknown as typeof fetch
    await expect(googleProvider({ clientId: 'c', clientSecret: 's' }, revoked).refresh!('RT')).rejects.toBeInstanceOf(GrantRevokedError)
    const down = (async () => new Response('leaky RT', { status: 503 })) as unknown as typeof fetch
    await expect(googleProvider({ clientId: 'c', clientSecret: 's' }, down).refresh!('RT')).rejects.toThrow(/^token endpoint 503$/)
    expect(microsoftProvider('c').refresh).toBeUndefined()
  })
  it('google revocation posts the token and throws when Google does not confirm', async () => {
    let sent = ''
    const ok = (async (_u: string, init: RequestInit) => { sent = String(init.body); return new Response('', { status: 200 }) }) as unknown as typeof fetch
    await googleProvider({ clientId: 'c', clientSecret: 's' }, ok).revoke!('RT')
    expect(sent).toBe('token=RT')
    const bad = (async () => new Response('', { status: 400 })) as unknown as typeof fetch
    await expect(googleProvider({ clientId: 'c', clientSecret: 's' }, bad).revoke!('RT')).rejects.toThrow()
    expect(microsoftProvider('c').revoke).toBeUndefined()
  })

})
