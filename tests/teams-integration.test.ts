import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

// Own SQLite store for this file (see teams-conversations.test.ts).
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-integration`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

import { startHttpServer, stopHttpServer } from '../src/http-server.js'
import { TeamsAdapter } from '../src/platform/teams/adapter.js'
import { InboundTokenValidator, OutboundTokenProvider, BOT_FRAMEWORK_ISSUER } from '../src/platform/teams/auth.js'
import { BotConnector } from '../src/platform/teams/connector.js'
import type { IncomingMessage } from '../src/platform/types.js'

const APP_ID = '11111111-2222-3333-4444-555555555555'
const APP_PORT = 3800 + Math.floor(Math.random() * 100)

let privateKey: PrivateKey
let jwks: { keys: Record<string, unknown>[] }
let connectorServer: Server
let connectorUrl: string
const connectorCalls: Array<{ method: string; url: string; body: unknown }> = []

beforeAll(async () => {
  const kp = await generateKeyPair('RS256')
  privateKey = kp.privateKey
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }

  connectorServer = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      connectorCalls.push({ method: req.method ?? '', url: req.url ?? '', body: data ? JSON.parse(data) : undefined })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: `reply-${connectorCalls.length}` }))
    })
  })
  await new Promise<void>((r) => connectorServer.listen(0, '127.0.0.1', () => r()))
  const addr = connectorServer.address() as { port: number }
  connectorUrl = `http://127.0.0.1:${addr.port}/`
})

afterAll(async () => {
  await stopHttpServer()
  await new Promise<void>((r) => connectorServer.close(() => r()))
})

// Waits for a condition instead of a fixed sleep: how long processActivity's
// background work (typing + reply, each a real HTTP round trip to the fake
// connector) takes to land varies with machine load, so a fixed delay is
// either too short (flaky failure) or wastefully long.
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function signed(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(BOT_FRAMEWORK_ISSUER)
    .setAudience(APP_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(privateKey)
}

describe('Teams end to end (HTTP in, connector out)', () => {
  it('accepts a signed activity, answers 200 first, and replies through the connector', async () => {
    const metaFetch = async (url: string): Promise<Response> =>
      url.endsWith('/openid')
        ? new Response(JSON.stringify({ jwks_uri: 'https://login.example/keys' }), { status: 200 })
        : new Response(JSON.stringify(jwks), { status: 200 })
    const tokens = new OutboundTokenProvider({
      appId: APP_ID,
      appSecret: 's',
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'bot-tok', expires_in: 3600 }), { status: 200 }),
    })
    const adapter = new TeamsAdapter({
      appId: APP_ID,
      appSecret: 's',
      validator: new InboundTokenValidator({ appId: APP_ID, fetchImpl: metaFetch, openIdConfigUrl: 'https://login.example/openid' }),
      tokens,
      connector: new BotConnector({ tokens }), // real fetch, against the local fake connector
      isAuthorizedChat: () => true,
    })
    const received: IncomingMessage[] = []
    adapter.onMessage(async (m) => {
      received.push(m)
      await adapter.sendTyping(m.chatId)
      await adapter.sendMessage(m.chatId, `echo: ${m.text}`)
    })
    await adapter.start()
    startHttpServer(APP_PORT)

    const activity = {
      type: 'message',
      id: 'e2e-1',
      text: 'ping',
      serviceUrl: connectorUrl,
      channelId: 'msteams',
      from: { id: '29:u', aadObjectId: 'aad-u' },
      recipient: { id: `28:${APP_ID}` },
      conversation: { id: 'a:e2e' },
    }
    const t0 = Date.now()
    const resp = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signed()}` },
      body: JSON.stringify(activity),
    })
    expect(resp.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(2000)

    // received flips to length 1 synchronously, before the handler's two
    // awaited connector calls (typing, then message) land - wait on the
    // actual state the assertions below depend on.
    await waitFor(() => connectorCalls.length >= 2)
    expect(received).toHaveLength(1)
    expect(connectorCalls.map((c) => (c.body as { type: string }).type)).toEqual(['typing', 'message'])
    expect(connectorCalls[1].url).toBe('/v3/conversations/a%3Ae2e/activities')
    expect((connectorCalls[1].body as { text: string }).text).toBe('echo: ping')

    const dup = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await signed()}` },
      body: JSON.stringify(activity),
    })
    expect(dup.status).toBe(200)
    // Dedup is a synchronous check before any network I/O; unlike the wait
    // above there's no later-arriving state to poll for, so this stays a
    // short fixed buffer rather than a condition wait.
    await new Promise((r) => setTimeout(r, 100))
    expect(received).toHaveLength(1)

    const bad = await fetch(`http://127.0.0.1:${APP_PORT}/api/teams/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ ...activity, id: 'e2e-2' }),
    })
    expect(bad.status).toBe(401)
    expect(received).toHaveLength(1)
    await adapter.stop()
  })
})
