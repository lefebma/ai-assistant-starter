/**
 * With no HTTP_BEARER_TOKEN and no public hostname, a loopback caller gets
 * into the operator API without a credential (open-loopback mode). The web
 * API must not inherit that: /api/web/* still needs a havn_web session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/config.js')>()),
  PRIMARY_CHAT_ID: '4242',
  HTTP_BEARER_TOKEN: '',
  PUBLIC_HOSTNAME: '',
}))

let port = 0
let server: typeof import('../src/http-server.js')

beforeAll(async () => {
  process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'web-open-loopback-'))
  delete process.env['HTTP_BEARER_TOKEN']
  const db = await import('../src/db.js')
  db.initDatabase()
  server = await import('../src/http-server.js')
  // Band 5575-5584.
  port = 5575 + Math.floor(Math.random() * 10)
  server.startHttpServer(port)
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready__`)
      break
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
})

afterAll(async () => {
  await server.stopHttpServer()
})

describe('open-loopback mode', () => {
  it('lets a loopback caller into an operator route with no credential', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/cockpit/mcp`)
    expect(r.status).toBe(200)
  })

  it('still gives /api/web/me a 401 without a web session', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/web/me`)
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'unauthorized' })
  })
})
