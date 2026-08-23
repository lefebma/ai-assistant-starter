import { describe, it, expect, afterEach } from 'vitest'
import { registerHttpRoute, startHttpServer, stopHttpServer } from '../src/http-server.js'

const PORT = 3900 + Math.floor(Math.random() * 100)

describe('registerHttpRoute', () => {
  afterEach(async () => {
    await stopHttpServer()
  })

  it('serves a registered route before the built-in ones and without bearer auth', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('routed')
    })
    startHttpServer(PORT)
    await new Promise(resolve => setTimeout(resolve, 10))
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('routed')
    unregister()
    const after = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`, { method: 'POST', body: '{}' })
    expect(after.status).toBe(405)
  })

  it('matches method and path exactly', async () => {
    const unregister = registerHttpRoute('POST', '/api/teams/messages', (_req, res) => {
      res.writeHead(200)
      res.end('routed')
    })
    startHttpServer(PORT)
    await new Promise(resolve => setTimeout(resolve, 10))
    const get = await fetch(`http://127.0.0.1:${PORT}/api/teams/messages`)
    expect(get.status).not.toBe(200)
    const other = await fetch(`http://127.0.0.1:${PORT}/api/teams/other`, { method: 'POST', body: '{}' })
    expect(other.status).toBe(405)
    unregister()
  })
})
