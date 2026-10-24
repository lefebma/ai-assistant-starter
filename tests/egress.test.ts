/**
 * Card #231: the egress policy, the per-run proxy (plain HTTP, HTTPS CONNECT,
 * redirects, internal addresses, live policy), the run wrapper and its tool
 * env, and the hosted cgroup helpers.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect, createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { decide, expandRules, isInternalAddress, listFromEnv, parseRule, type EgressPolicy } from '../src/egress/policy.js'
import { openRunProxy, type EgressRecord } from '../src/egress/proxy.js'
import { chatPolicy, currentProxy, parsePorts, policyFor, proxyEnv, rolePolicy, withEgress } from '../src/egress/index.js'
import { toolEnv, toolEnvOption } from '../src/egress/tool-env.js'
import { inToolsCgroup, nftRules } from '../src/egress/hosted.js'
import { withGrant } from '../src/assurance/grant.js'
import { BUILTIN_ROLES } from '../src/assurance/roles.js'

const cfg = { approved: ['api.partner.example'], read: ['docs.example.org'], imapHosts: () => ['imap.mail.yahoo.com:993', 'smtp.mail.yahoo.com:465'] }
const role = (id: string) => BUILTIN_ROLES.find((r) => r.id === id)!

describe('policy', () => {
  it('parses hosts, ports, wildcards and URLs', () => {
    expect(parseRule('Example.com')).toEqual({ host: 'example.com', wildcard: false })
    expect(parseRule('https://example.com:8443/path')).toEqual({ host: 'example.com', wildcard: false, port: 8443 })
    expect(parseRule('*.slack.com')).toEqual({ host: 'slack.com', wildcard: true })
    expect(parseRule('[::1]:80')).toEqual({ host: '::1', wildcard: false, port: 80 })
    expect(parseRule('bad host!')).toBeNull()
    expect(parseRule('x.com:99999')).toBeNull()
    expect(listFromEnv('a.com, b.com\nc.com')).toEqual(['a.com', 'b.com', 'c.com'])
  })

  it('default deny; a host without a port means 80 and 443', () => {
    const p: EgressPolicy = { name: 't', write: expandRules(['a.example']), read: [] }
    expect(decide(p, { host: 'a.example', port: 443, method: null }).allow).toBe(true)
    expect(decide(p, { host: 'a.example', port: 80, method: 'POST' }).allow).toBe(true)
    expect(decide(p, { host: 'a.example', port: 8080, method: 'GET' }).allow).toBe(false)
    expect(decide(p, { host: 'b.example', port: 443, method: null })).toMatchObject({ allow: false, reason: expect.stringMatching(/not on t's allowlist/) })
  })

  it('a wildcard covers subdomains only', () => {
    const p: EgressPolicy = { name: 't', write: expandRules(['*.slack.com']), read: [] }
    expect(decide(p, { host: 'files.slack.com', port: 443, method: null }).allow).toBe(true)
    expect(decide(p, { host: 'slack.com', port: 443, method: null }).allow).toBe(false)
    expect(decide(p, { host: 'evilslack.com', port: 443, method: null }).allow).toBe(false)
  })

  it('read: only safe methods over plain HTTP; a tunnel cannot be read, so it is allowed', () => {
    const p: EgressPolicy = { name: 'r', write: [], read: expandRules(['docs.example.org']) }
    expect(decide(p, { host: 'docs.example.org', port: 80, method: 'GET' }).allow).toBe(true)
    expect(decide(p, { host: 'docs.example.org', port: 80, method: 'POST' })).toMatchObject({ allow: false, reason: expect.stringMatching(/may only read/) })
    expect(decide(p, { host: 'docs.example.org', port: 443, method: null })).toEqual({ allow: true, via: 'read' })
  })

  it('internal addresses need their exact address on the list', () => {
    expect(isInternalAddress('127.0.0.1')).toBe(true)
    expect(isInternalAddress('169.254.169.254')).toBe(true)
    expect(isInternalAddress('10.1.2.3')).toBe(true)
    expect(isInternalAddress('::ffff:192.168.1.5')).toBe(true)
    expect(isInternalAddress('fd00::1')).toBe(true)
    expect(isInternalAddress('8.8.8.8')).toBe(false)
    const wide: EgressPolicy = { name: 'w', write: expandRules(['127.0.0.1:3030']), read: [] }
    expect(decide(wide, { host: '127.0.0.1', port: 3030, method: 'GET' }).allow).toBe(true)
    expect(decide(wide, { host: '169.254.169.254', port: 80, method: 'GET' }).allow).toBe(false)
  })

  it('groups expand: services, imap accounts, approved and read lists', () => {
    const chat = chatPolicy(cfg)
    for (const host of ['api.anthropic.com', 'graph.microsoft.com', 'gmail.googleapis.com', 'api.partner.example']) {
      expect(decide(chat, { host, port: 443, method: null }).allow, host).toBe(true)
    }
    expect(decide(chat, { host: 'imap.mail.yahoo.com', port: 993, method: null }).allow).toBe(true)
    expect(decide(chat, { host: 'docs.example.org', port: 80, method: 'POST' }).allow).toBe(false)
    expect(decide(chat, { host: 'pastebin.com', port: 443, method: null }).allow).toBe(false)
  })

  it('built-in roles: triage reaches mail only, research reads the lists, full is chat', () => {
    const triage = rolePolicy(role('inbox-triage'), cfg)
    expect(decide(triage, { host: 'graph.microsoft.com', port: 443, method: null }).allow).toBe(true)
    expect(decide(triage, { host: 'api.partner.example', port: 443, method: null }).allow).toBe(false)
    const research = rolePolicy(role('research'), cfg)
    expect(decide(research, { host: 'docs.example.org', port: 443, method: null }).allow).toBe(true)
    expect(decide(research, { host: 'gmail.googleapis.com', port: 443, method: null }).allow).toBe(false)
    expect(rolePolicy(role('full'), cfg).write).toEqual(chatPolicy(cfg).write)
  })

  it('a role with no egress, an unknown role and an expired role reach only the AI, or nothing', () => {
    const bare = rolePolicy({ id: 'x', summary: '', tools: ['Bash'] }, cfg)
    expect(bare.write.map((r) => r.host)).toEqual(['api.anthropic.com'])
    expect(policyFor('nobody-defined-this', cfg).write.map((r) => r.host)).toEqual(['api.anthropic.com'])
    expect(rolePolicy({ id: 'old', summary: '', tools: ['*'], expiresAt: '2020-01-01' }, cfg).write).toEqual([])
    expect(policyFor(null, cfg).name).toBe('chat')
  })

  it('EGRESS_PORTS parses a high range only', () => {
    expect(parsePorts('47000-47999')).toEqual([47000, 47999])
    expect(parsePorts('80-90')).toBeUndefined()
    expect(parsePorts('nope')).toBeUndefined()
  })
})

describe('proxy', () => {
  let site: Server
  let tcp: TcpServer
  let sitePort = 0
  let tcpPort = 0

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://blocked.example/x' }); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`${req.method} ${req.url} host=${req.headers.host} auth=${req.headers['proxy-authorization'] ?? ''}`)
    })
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
    sitePort = (site.address() as AddressInfo).port
    tcp = createTcpServer((s) => { s.on('error', () => {}); s.end('hello over the tunnel') })
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
    tcpPort = (tcp.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((r) => site.close(() => r()))
    await new Promise<void>((r) => tcp.close(() => r()))
  })

  // Names that "resolve" to the local test servers, as a public name would.
  const resolveTo = (map: Record<string, string>) => async (h: string) => { if (!map[h]) throw new Error('nx'); return map[h] }

  function viaProxy(proxyPort: number, url: string, method = 'GET', body?: string): Promise<{ status: number; body: string; denied: boolean }> {
    return new Promise((resolveP, reject) => {
      const u = new URL(url)
      const req = request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: u.host, 'proxy-authorization': 'Basic x' } }, (r) => {
        let b = ''
        r.on('data', (c) => { b += c })
        r.on('end', () => resolveP({ status: r.statusCode ?? 0, body: b, denied: r.headers['x-havn-egress'] === 'denied' }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  function tunnel(proxyPort: number, authority: string): Promise<{ status: string; data: string }> {
    return new Promise((resolveP, reject) => {
      const s = connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
      let buf = ''
      s.on('data', (c) => { buf += c })
      s.on('end', () => resolveP({ status: buf.split('\r\n')[0], data: buf }))
      s.on('error', reject)
    })
  }

  it('forwards an allowed plain HTTP request, strips proxy credentials, and records it', async () => {
    const seen: EgressRecord[] = []
    const p2 = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${sitePort}`]), read: [] }), record: (r) => seen.push(r) })
    const r = await viaProxy(p2.port, `http://127.0.0.1:${sitePort}/page?q=1`, 'POST', 'a=1')
    expect(r.status).toBe(200)
    expect(r.body).toBe(`POST /page?q=1 host=127.0.0.1:${sitePort} auth=`)
    expect(seen.at(-1)).toMatchObject({ method: 'POST', host: '127.0.0.1', port: sitePort, path: '/page', decision: 'allowed' })
    await p2.close()
  })

  it('denies an unlisted host with 403 and the reason, and records it', async () => {
    const seen: EgressRecord[] = []
    const p = await openRunProxy({ policy: () => ({ name: 'chat', write: [], read: [] }), record: (r) => seen.push(r) })
    const r = await viaProxy(p.port, `http://127.0.0.1:${sitePort}/page`)
    expect(r).toMatchObject({ status: 403, denied: true })
    expect(r.body).toMatch(/not on chat's allowlist/)
    expect(seen).toEqual([expect.objectContaining({ decision: 'denied' })])
    await p.close()
  })

  it('checks each redirect hop on its own: the client follows, the proxy judges again', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${sitePort}`]), read: [] }) })
    const first = await viaProxy(p.port, `http://127.0.0.1:${sitePort}/redirect`)
    expect(first.status).toBe(302)
    const second = await viaProxy(p.port, 'http://blocked.example/x')
    expect(second.denied).toBe(true)
    await p.close()
  })

  it('tunnels an allowed CONNECT and refuses one that is not listed', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${tcpPort}`]), read: [] }) })
    const ok = await tunnel(p.port, `127.0.0.1:${tcpPort}`)
    expect(ok.status).toBe('HTTP/1.1 200 Connection Established')
    expect(ok.data).toContain('hello over the tunnel')
    const no = await tunnel(p.port, 'pastebin.com:443')
    expect(no.status).toBe('HTTP/1.1 403 Forbidden')
    await p.close()
  })

  it('refuses a listed name that resolves to an internal address', async () => {
    const seen: EgressRecord[] = []
    const p = await openRunProxy({
      policy: () => ({ name: 't', write: expandRules(['sneaky.example']), read: [] }),
      resolve: resolveTo({ 'sneaky.example': '169.254.169.254' }),
      record: (r) => seen.push(r),
    })
    const r = await tunnel(p.port, 'sneaky.example:443')
    expect(r.status).toBe('HTTP/1.1 403 Forbidden')
    expect(seen[0].reason).toMatch(/internal address/)
    await p.close()
  })

  it('reads the policy per connection, so a change applies to the next one', async () => {
    let allow = true
    const p = await openRunProxy({ policy: () => ({ name: 't', write: allow ? expandRules([`127.0.0.1:${sitePort}`]) : [], read: [] }) })
    expect((await viaProxy(p.port, `http://127.0.0.1:${sitePort}/a`)).status).toBe(200)
    allow = false
    expect((await viaProxy(p.port, `http://127.0.0.1:${sitePort}/b`)).denied).toBe(true)
    await p.close()
  })

  it('a client that resets mid-tunnel does not crash the process, and the proxy keeps serving', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${tcpPort}`, `127.0.0.1:${sitePort}`]), read: [] }), resolve: async () => { await new Promise((r) => setTimeout(r, 50)); return '8.8.8.8' } })
    for (const authority of ['slow.example:443', `127.0.0.1:${tcpPort}`]) {
      await new Promise<void>((r) => {
        const s = connect(p.port, '127.0.0.1', () => { s.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`); s.resetAndDestroy(); r() })
        s.on('error', () => r())
      })
    }
    await new Promise((r) => setTimeout(r, 100))
    expect((await viaProxy(p.port, `http://127.0.0.1:${sitePort}/still-up`)).status).toBe(200)
    await p.close()
  })

  it('binds inside the configured port range', async () => {
    const p = await openRunProxy({ policy: () => chatPolicy(cfg), ports: [47900, 47999] })
    expect(p.port).toBeGreaterThanOrEqual(47900)
    expect(p.port).toBeLessThanOrEqual(47999)
    await p.close()
  })
})

describe('run wrapper and tool env', () => {
  it('off: no proxy, no env', async () => {
    await withEgress({ enforce: false }, async () => {
      expect(currentProxy()).toBeUndefined()
      expect(toolEnvOption(undefined)).toBeUndefined()
    })
  })

  it('enforce: the run gets a proxy, its tools get the env, and it closes after', async () => {
    let url = ''
    await withEgress({ enforce: true, cfg, record: () => {} }, async () => {
      url = currentProxy()!
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const env = toolEnv({ PATH: '/bin' })
      expect(env).toMatchObject({ PATH: '/bin', HTTPS_PROXY: url, http_proxy: url, NO_PROXY: '', NODE_USE_ENV_PROXY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
      expect(proxyEnv(url).ALL_PROXY).toBe(url)
    })
    const port = Number(new URL(url).port)
    await expect(new Promise((res, rej) => { const s = connect(port, '127.0.0.1', () => { s.destroy(); res('open') }); s.on('error', rej) })).rejects.toThrow()
  })

  it('a revoked grant mid-run shuts the network: nothing may leave', async () => {
    let ok = true
    const grant = () => (ok ? { ok: true as const, role: null, taskId: 't' } : { ok: false as const, reason: 'the owner paused this scheduled task' })
    const seen: EgressRecord[] = []
    await withGrant(grant, () => withEgress({ enforce: true, cfg: { ...cfg, approved: ['127.0.0.1:9'] }, record: (r) => seen.push(r) }, async () => {
      const port = Number(new URL(currentProxy()!).port)
      ok = false
      await new Promise<void>((r) => {
        const s = connect(port, '127.0.0.1', () => s.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\n\r\n'))
        s.on('data', () => s.destroy())
        s.on('close', () => r())
      })
    }))
    expect(seen[0]).toMatchObject({ decision: 'denied', reason: expect.stringMatching(/paused/) })
  })
})

describe('hosted cgroup helpers', () => {
  it('wraps a command so it joins the cgroup before it execs, and only then', () => {
    expect(inToolsCgroup('claude', ['--x'], '')).toEqual({ command: 'claude', args: ['--x'] })
    const w = inToolsCgroup('claude', ['--x', 'a b'], '/sys/fs/cgroup/system.slice/havn.service/tools')
    expect(w.command).toBe('/bin/sh')
    expect(w.args).toEqual(['-c', 'echo $$ > "$0/cgroup.procs" && exec "$@"', '/sys/fs/cgroup/system.slice/havn.service/tools', 'claude', '--x', 'a b'])
  })

  it('the nftables rule lets the cgroup reach only the proxy ports, and drops the rest', () => {
    const t = nftRules('system.slice/havn.service/tools', [47000, 47999])
    expect(t).toContain('socket cgroupv2 level 3 "system.slice/havn.service/tools" ip daddr 127.0.0.1 tcp dport 47000-47999 accept')
    expect(t).toMatch(/level 3 "system\.slice\/havn\.service\/tools" drop/)
    expect(t).toContain('table inet havn_egress')
  })
})
