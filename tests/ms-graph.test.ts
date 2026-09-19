import { describe, it, expect } from 'vitest'
import { GraphClient } from '../src/ms/graph.js'
import type { MsTokens } from '../src/ms/auth.js'

const CFG = { clientId: 'cid', tenantId: 'common' }
const FRESH: MsTokens = { accessToken: 'fresh', refreshToken: 'r', expiresAt: 10_000 }
const STALE: MsTokens = { accessToken: 'stale', refreshToken: 'r', expiresAt: 100 }

function harness(opts: { tokens: MsTokens | null; responses: { status: number; body: unknown }[] }) {
  const calls: { url: string; auth?: string; method: string; headers?: Record<string, string> }[] = []
  const saved: MsTokens[] = []
  let queue = [...opts.responses]
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => {
    if (url.includes('login.microsoftonline.com')) {
      calls.push({ url, method: 'POST' })
      return { ok: true, status: 200, json: async () => ({ access_token: 'renewed', refresh_token: 'r2', expires_in: 3600 }), text: async () => '' }
    }
    calls.push({ url, auth: init?.headers?.['Authorization'], method: init?.method ?? 'GET', headers: init?.headers })
    const next = queue.shift() ?? { status: 200, body: {} }
    return { ok: next.status < 400, status: next.status, json: async () => next.body, text: async () => JSON.stringify(next.body) }
  }) as never
  const client = new GraphClient({
    config: CFG,
    account: 'work',
    scopes: 'Mail.Read',
    fetchImpl,
    now: () => 1000,
    loadTokens: () => opts.tokens,
    saveTokens: (_a, t) => void saved.push(t),
  })
  return { client, calls, saved, tokenCalls: () => calls.filter((c) => c.url.includes('login.')) }
}

describe('GraphClient', () => {
  it('uses a live token without touching the token endpoint', async () => {
    // The scripts this replaces refreshed before every single request. That is
    // a round trip to a rate-limited endpoint per operation.
    const h = harness({ tokens: FRESH, responses: [{ status: 200, body: { value: [] } }] })
    await h.client.get('/me/messages')
    expect(h.tokenCalls()).toHaveLength(0)
    expect(h.calls[0]!.auth).toBe('Bearer fresh')
  })

  it('refreshes a stale token first, then calls Graph', async () => {
    const h = harness({ tokens: STALE, responses: [{ status: 200, body: { ok: true } }] })
    await h.client.get('/me/messages')
    expect(h.tokenCalls()).toHaveLength(1)
    expect(h.calls[1]!.auth).toBe('Bearer renewed')
  })

  it('persists the renewed token so the next process does not refresh again', async () => {
    const h = harness({ tokens: STALE, responses: [{ status: 200, body: {} }] })
    await h.client.get('/me/messages')
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]!.accessToken).toBe('renewed')
  })

  it('retries once on a 401, in case the token died early', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 401, body: { error: { message: 'expired' } } }, { status: 200, body: { ok: true } }] })
    await h.client.get('/me/messages')
    expect(h.tokenCalls()).toHaveLength(1)
    expect(h.calls.at(-1)!.auth).toBe('Bearer renewed')
  })

  it('does not loop on a second 401', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 401, body: { error: { message: 'no' } } }, { status: 401, body: { error: { message: 'no' } } }] })
    await expect(h.client.get('/me/messages')).rejects.toThrow(/401/)
    expect(h.tokenCalls()).toHaveLength(1)
  })

  it('surfaces the Graph error message rather than a bare status', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 403, body: { error: { message: 'Access is denied' } } }] })
    await expect(h.client.get('/me/messages')).rejects.toThrow(/Access is denied/)
  })

  it('tells the owner to sign in when there is no token at all', async () => {
    const h = harness({ tokens: null, responses: [] })
    await expect(h.client.get('/me/messages')).rejects.toThrow(/sign in|ms-auth/i)
  })

  it('targets the v1.0 Graph endpoint', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 200, body: {} }] })
    await h.client.get('/me/messages')
    expect(h.calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/messages')
  })

  it('sends a body on post', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 201, body: { id: 'x' } }] })
    const out = await h.client.post('/me/messages', { subject: 'hi' })
    expect(h.calls[0]!.method).toBe('POST')
    expect(out).toEqual({ id: 'x' })
  })

  it('passes extra headers through, but never lets one replace the token', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 200, body: {} }] })
    await h.client.get('/me/messages/1', { Prefer: 'outlook.body-content-type="text"', Authorization: 'Bearer forged' })
    expect(h.calls[0]!.headers?.['Prefer']).toBe('outlook.body-content-type="text"')
    expect(h.calls[0]!.auth).toBe('Bearer fresh')
  })

  it('keeps the extra headers on the retry after a 401', async () => {
    const h = harness({ tokens: FRESH, responses: [{ status: 401, body: {} }, { status: 200, body: {} }] })
    await h.client.get('/me/messages/1', { Prefer: 'x' })
    const graphCalls = h.calls.filter((c) => c.url.includes('graph.microsoft.com'))
    expect(graphCalls).toHaveLength(2)
    expect(graphCalls[1]!.headers?.['Prefer']).toBe('x')
    expect(graphCalls[1]!.auth).toBe('Bearer renewed')
  })
})
