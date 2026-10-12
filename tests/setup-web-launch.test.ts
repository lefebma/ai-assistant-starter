import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LAUNCH_ALREADY_SET_UP,
  LAUNCH_FAILED,
  LAUNCH_OK,
  LAUNCH_PORT_BUSY,
  launchInBackground,
  probeSetupPort,
  type LaunchDeps,
  type PortState,
} from '../src/setup/web/launch.js'

function deps(over: Partial<LaunchDeps> & { states?: PortState[]; dies?: boolean } = {}) {
  const states = over.states ?? ['free', 'free', 'setup']
  let i = 0
  const calls = { started: 0, opened: 0, slept: 0 }
  const d: LaunchDeps = {
    alreadySetUp: () => false,
    probe: async () => states[Math.min(i++, states.length - 1)]!,
    startServer: () => {
      calls.started++
      return { exited: () => !!over.dies }
    },
    openBrowser: () => calls.opened++,
    sleep: async () => {
      calls.slept++
    },
    log: () => {},
    ...over,
  }
  return { d, calls }
}

describe('launchInBackground', () => {
  it('starts the server and returns once the page answers', async () => {
    const { d, calls } = deps()
    expect(await launchInBackground(d)).toBe(LAUNCH_OK)
    expect(calls.started).toBe(1)
    // The child opens the browser itself; the launcher does not open a second tab.
    expect(calls.opened).toBe(0)
  })

  it('reopens the page instead of starting a second server', async () => {
    const { d, calls } = deps({ states: ['setup'] })
    expect(await launchInBackground(d)).toBe(LAUNCH_OK)
    expect(calls.started).toBe(0)
    expect(calls.opened).toBe(1)
  })

  it('refuses on an install that is already set up', async () => {
    const { d, calls } = deps({ alreadySetUp: () => true })
    expect(await launchInBackground(d)).toBe(LAUNCH_ALREADY_SET_UP)
    expect(calls.started).toBe(0)
  })

  it('does not open whatever else is on the port', async () => {
    const { d, calls } = deps({ states: ['other'] })
    expect(await launchInBackground(d)).toBe(LAUNCH_PORT_BUSY)
    expect(calls.started + calls.opened).toBe(0)
  })

  it('fails fast when the server dies on start', async () => {
    const { d, calls } = deps({ states: ['free'], dies: true })
    expect(await launchInBackground(d)).toBe(LAUNCH_FAILED)
    expect(calls.slept).toBe(1)
  })

  it('gives up after the wait when the page never answers', async () => {
    const { d } = deps({ states: ['free'] })
    expect(await launchInBackground(d)).toBe(LAUNCH_FAILED)
  })
})

describe('probeSetupPort', () => {
  async function serve(body: unknown, status = 200): Promise<{ server: Server; port: number }> {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { server, port: (server.address() as AddressInfo).port }
  }

  it('recognises the local setup page', async () => {
    const { server, port } = await serve({ mode: 'local' })
    expect(await probeSetupPort(fetch, port)).toBe('setup')
    server.close()
  })

  it('treats anything else listening as someone else', async () => {
    const a = await serve({ ok: true })
    expect(await probeSetupPort(fetch, a.port)).toBe('other')
    a.server.close()
    const b = await serve({ error: 'nope' }, 404)
    expect(await probeSetupPort(fetch, b.port)).toBe('other')
    b.server.close()
  })

  it('reports a free port when nothing is listening', async () => {
    const { server, port } = await serve({})
    await new Promise((r) => server.close(r))
    expect(await probeSetupPort(fetch, port)).toBe('free')
  })
})
