import { describe, it, expect } from 'vitest'
import { BotConnector, ConnectorError } from '../src/platform/teams/connector.js'
import { OutboundTokenProvider } from '../src/platform/teams/auth.js'
import { buildTextActivity } from '../src/platform/teams/activities.js'

const REF = { conversationId: 'a:1conv', serviceUrl: 'https://smba.trafficmanager.net/amer/', botId: '28:bot', userId: 'aad-1' }

function tokens(counter: { tokenCalls: number }) {
  return new OutboundTokenProvider({
    appId: 'app',
    appSecret: 's',
    fetchImpl: async () => {
      counter.tokenCalls++
      return new Response(JSON.stringify({ access_token: `tok-${counter.tokenCalls}`, expires_in: 3600 }), { status: 200 })
    },
  })
}

type Call = { url: string; method: string; auth: string; body: unknown }

function connector(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>, calls: Call[], counter = { tokenCalls: 0 }) {
  const sleeps: number[] = []
  const c = new BotConnector({
    tokens: tokens(counter),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: String((init?.headers as Record<string, string>)?.Authorization), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const next = responses.shift() ?? { status: 500 }
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers })
    },
  })
  return { c, sleeps, counter }
}

describe('BotConnector', () => {
  it('posts an activity with the conversation reference filled in and returns the new id', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 201, body: { id: 'new-1' } }], calls)
    const id = await c.sendActivity(REF, buildTextActivity('hi'))
    expect(id).toBe('new-1')
    expect(calls[0].url).toBe('https://smba.trafficmanager.net/amer/v3/conversations/a%3A1conv/activities')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].auth).toBe('Bearer tok-1')
    expect(calls[0].body).toMatchObject({ type: 'message', text: 'hi', from: { id: '28:bot' }, recipient: { id: 'aad-1' }, conversation: { id: 'a:1conv' } })
  })

  it('PUTs updates and DELETEs deletions at the activity url', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 200, body: { id: 'x' } }, { status: 200 }], calls)
    await c.updateActivity(REF, 'act-9', buildTextActivity('edited'))
    await c.deleteActivity(REF, 'act-9')
    expect(calls[0].url).toBe('https://smba.trafficmanager.net/amer/v3/conversations/a%3A1conv/activities/act-9')
    expect(calls[0].method).toBe('PUT')
    expect(calls[1].method).toBe('DELETE')
  })

  it('sends a typing activity', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 200, body: {} }], calls)
    await c.sendTyping(REF)
    expect(calls[0].body).toMatchObject({ type: 'typing' })
  })

  it('refreshes the token and retries once on 401', async () => {
    const calls: Call[] = []
    const { c, counter } = connector([{ status: 401 }, { status: 201, body: { id: 'ok' } }], calls)
    expect(await c.sendActivity(REF, buildTextActivity('hi'))).toBe('ok')
    expect(counter.tokenCalls).toBe(2)
    expect(calls[1].auth).toBe('Bearer tok-2')
  })

  it('honours Retry-After once on 429', async () => {
    const calls: Call[] = []
    const { c, sleeps } = connector([{ status: 429, headers: { 'Retry-After': '3' } }, { status: 201, body: { id: 'ok' } }], calls)
    expect(await c.sendActivity(REF, buildTextActivity('hi'))).toBe('ok')
    expect(sleeps).toEqual([3000])
  })

  it('retries once after a second on 5xx, then throws', async () => {
    const calls: Call[] = []
    const { c, sleeps } = connector([{ status: 503 }, { status: 503 }], calls)
    await expect(c.sendActivity(REF, buildTextActivity('hi'))).rejects.toBeInstanceOf(ConnectorError)
    expect(sleeps).toEqual([1000])
    expect(calls).toHaveLength(2)
  })

  it('throws immediately on other client errors', async () => {
    const calls: Call[] = []
    const { c } = connector([{ status: 400, body: { error: { message: 'bad' } } }], calls)
    await expect(c.sendActivity(REF, buildTextActivity('hi'))).rejects.toMatchObject({ status: 400 })
    expect(calls).toHaveLength(1)
  })
})
