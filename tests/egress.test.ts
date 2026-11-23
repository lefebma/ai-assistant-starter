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
import { openRunProxy, type EgressRecord, type RunProxy } from '../src/egress/proxy.js'
import { chatPolicy, currentProxy, parsePorts, policyFor, proxyEnv, rolePolicy, withEgress } from '../src/egress/index.js'
import { toolEnv, toolEnvOption } from '../src/egress/tool-env.js'
import { inToolsCgroup, nftRules } from '../src/egress/hosted.js'
import { EGRESSD_PY, EGRESSD_UNIT, JOIN_PY, TOOLS_CGROUP, TOOLS_CGROUP_REL } from '../scripts/hosted/egress-helper.js'
import { withGrant } from '../src/assurance/grant.js'
import { BUILTIN_ROLES } from '../src/assurance/roles.js'

// The Proxy-Authorization a client builds from a proxy URL with credentials.
const authOf = (proxyUrl: string) => { const u = new URL(proxyUrl); return `Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}` }

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

  function viaProxy(p: RunProxy, url: string, method = 'GET', body?: string, auth: string | null = p.authorization): Promise<{ status: number; body: string; denied: boolean }> {
    return new Promise((resolveP, reject) => {
      const u = new URL(url)
      const req = request({ host: '127.0.0.1', port: p.port, method, path: url, headers: { host: u.host, ...(auth ? { 'proxy-authorization': auth } : {}) } }, (r) => {
        let b = ''
        r.on('data', (c) => { b += c })
        r.on('end', () => resolveP({ status: r.statusCode ?? 0, body: b, denied: r.headers['x-havn-egress'] === 'denied' }))
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  function tunnel(p: RunProxy, authority: string, auth: string | null = p.authorization): Promise<{ status: string; data: string }> {
    return new Promise((resolveP, reject) => {
      const s = connect(p.port, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`))
      let buf = ''
      s.on('data', (c) => { buf += c })
      s.on('end', () => resolveP({ status: buf.split('\r\n')[0], data: buf }))
      s.on('error', reject)
    })
  }

  it('forwards an allowed plain HTTP request, strips proxy credentials, and records it', async () => {
    const seen: EgressRecord[] = []
    const p2 = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${sitePort}`]), read: [] }), record: (r) => seen.push(r) })
    const r = await viaProxy(p2, `http://127.0.0.1:${sitePort}/page?q=1`, 'POST', 'a=1')
    expect(r.status).toBe(200)
    expect(r.body).toBe(`POST /page?q=1 host=127.0.0.1:${sitePort} auth=`)
    expect(seen.at(-1)).toMatchObject({ method: 'POST', host: '127.0.0.1', port: sitePort, path: '/page', decision: 'allowed' })
    await p2.close()
  })

  it('denies an unlisted host with 403 and the reason, and records it', async () => {
    const seen: EgressRecord[] = []
    const p = await openRunProxy({ policy: () => ({ name: 'chat', write: [], read: [] }), record: (r) => seen.push(r) })
    const r = await viaProxy(p, `http://127.0.0.1:${sitePort}/page`)
    expect(r).toMatchObject({ status: 403, denied: true })
    expect(r.body).toMatch(/not on chat's allowlist/)
    expect(seen).toEqual([expect.objectContaining({ decision: 'denied' })])
    await p.close()
  })

  it('checks each redirect hop on its own: the client follows, the proxy judges again', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${sitePort}`]), read: [] }) })
    const first = await viaProxy(p, `http://127.0.0.1:${sitePort}/redirect`)
    expect(first.status).toBe(302)
    const second = await viaProxy(p, 'http://blocked.example/x')
    expect(second.denied).toBe(true)
    await p.close()
  })

  it('tunnels an allowed CONNECT and refuses one that is not listed', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${tcpPort}`]), read: [] }) })
    const ok = await tunnel(p, `127.0.0.1:${tcpPort}`)
    expect(ok.status).toBe('HTTP/1.1 200 Connection Established')
    expect(ok.data).toContain('hello over the tunnel')
    const no = await tunnel(p, 'pastebin.com:443')
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
    const r = await tunnel(p, 'sneaky.example:443')
    expect(r.status).toBe('HTTP/1.1 403 Forbidden')
    expect(seen[0].reason).toMatch(/internal address/)
    await p.close()
  })

  it('reads the policy per connection, so a change applies to the next one', async () => {
    let allow = true
    const p = await openRunProxy({ policy: () => ({ name: 't', write: allow ? expandRules([`127.0.0.1:${sitePort}`]) : [], read: [] }) })
    expect((await viaProxy(p, `http://127.0.0.1:${sitePort}/a`)).status).toBe(200)
    allow = false
    expect((await viaProxy(p, `http://127.0.0.1:${sitePort}/b`)).denied).toBe(true)
    await p.close()
  })

  it('a client that resets mid-tunnel does not crash the process, and the proxy keeps serving', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${tcpPort}`, `127.0.0.1:${sitePort}`]), read: [] }), resolve: async () => { await new Promise((r) => setTimeout(r, 50)); return '8.8.8.8' } })
    for (const authority of ['slow.example:443', `127.0.0.1:${tcpPort}`]) {
      await new Promise<void>((r) => {
        const s = connect(p.port, '127.0.0.1', () => { s.write(`CONNECT ${authority} HTTP/1.1\r\nProxy-Authorization: ${p.authorization}\r\n\r\n`); s.resetAndDestroy(); r() })
        s.on('error', () => r())
      })
    }
    await new Promise((r) => setTimeout(r, 100))
    expect((await viaProxy(p, `http://127.0.0.1:${sitePort}/still-up`)).status).toBe(200)
    await p.close()
  })

  it('binds inside the configured port range', async () => {
    const p = await openRunProxy({ policy: () => chatPolicy(cfg), ports: [47900, 47999] })
    expect(p.port).toBeGreaterThanOrEqual(47900)
    expect(p.port).toBeLessThanOrEqual(47999)
    await p.close()
  })

  it("refuses a caller without this proxy's secret, so a run cannot borrow another run's allowlist", async () => {
    const seen: EgressRecord[] = []
    const policy = (): EgressPolicy => ({ name: 'chat', write: expandRules([`127.0.0.1:${sitePort}`, `127.0.0.1:${tcpPort}`]), read: [] })
    const chat = await openRunProxy({ policy, record: (r) => seen.push(r) })
    const job = await openRunProxy({ policy })
    expect(chat.url).not.toBe(job.url)
    for (const auth of [null, 'Basic x', job.authorization]) {
      const r = await viaProxy(chat, `http://127.0.0.1:${sitePort}/a`, 'GET', undefined, auth)
      expect(r.status).toBe(407)
      expect(r.denied).toBe(true)
      const t = await tunnel(chat, `127.0.0.1:${tcpPort}`, auth)
      expect(t.status).toMatch(/^HTTP\/1\.1 407/)
      expect(t.data).toMatch(/Proxy-Authenticate: Basic/)
    }
    // No header is a browser's first try, answered silently; a wrong one is a probe and recorded.
    expect(seen.length).toBe(4)
    expect(seen.every((r) => r.decision === 'denied' && /credentials/.test(r.reason ?? ''))).toBe(true)
    expect((await viaProxy(chat, `http://127.0.0.1:${sitePort}/a`)).status).toBe(200)
    expect(authOf(chat.url)).toBe(chat.authorization)
    await chat.close()
    await job.close()
  })

  it('a proxy opened with auth off accepts any caller (test-only mode)', async () => {
    const p = await openRunProxy({ policy: () => ({ name: 't', write: expandRules([`127.0.0.1:${sitePort}`]), read: [] }), auth: false })
    expect(p.url).toBe(p.server)
    expect(p.authorization).toBeNull()
    expect((await viaProxy(p, `http://127.0.0.1:${sitePort}/a`, 'GET', undefined, null)).status).toBe(200)
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
      expect(url).toMatch(/^http:\/\/run:[0-9a-f]{48}@127\.0\.0\.1:\d+$/)
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
      const auth = authOf(currentProxy()!)
      ok = false
      await new Promise<void>((r) => {
        const s = connect(port, '127.0.0.1', () => s.write(`CONNECT 127.0.0.1:9 HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\n`))
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

  it('with the root helper, the shell asks it to move the shell in, and execs the tool only if it did (card #307)', () => {
    const w = inToolsCgroup('claude', ['--x', 'a b'], '/sys/fs/cgroup/havn-tools', '/usr/local/lib/havn/tools-join')
    expect(w).toEqual({ command: '/bin/sh', args: ['-c', '"$0" && exec "$@"', '/usr/local/lib/havn/tools-join', 'claude', '--x', 'a b'] })
  })

  it('the tools cgroup sits at the top of the tree, where only root may move a process in or out (card #307)', () => {
    expect(TOOLS_CGROUP).toBe('/sys/fs/cgroup/havn-tools')
    expect(nftRules(TOOLS_CGROUP_REL, [47000, 47999])).toContain('socket cgroupv2 level 1 "havn-tools" drop')
  })

  it('the nftables rule lets the cgroup reach only the proxy ports, and drops the rest', () => {
    const t = nftRules('system.slice/havn.service/tools', [47000, 47999])
    expect(t).toContain('socket cgroupv2 level 3 "system.slice/havn.service/tools" ip daddr 127.0.0.1 tcp dport 47000-47999 accept')
    expect(t).toMatch(/level 3 "system\.slice\/havn\.service\/tools" drop/)
    expect(t).toContain('table inet havn_egress')
  })

  it('lets the cgroup reach a local port only when the listener is in the cgroup too (card #278)', () => {
    // Playwright drives the Chromium it starts over a random local debugging
    // port; the kernel rule dropped it, so no browser task could start.
    const t = nftRules('system.slice/havn.service/tools', [47000, 47999])
    const cg = 'socket cgroupv2 level 3 "system.slice/havn.service/tools"'
    const lines = t.split('\n').map((l) => l.trim())
    const out = lines.slice(lines.indexOf('chain out {'), lines.indexOf('chain in {'))
    const inn = lines.slice(lines.indexOf('chain in {'))
    // Proxy ports first and unmarked; other loopback connections are marked before the drop.
    expect(out.findIndex((l) => l.includes('dport 47000-47999 accept'))).toBeLessThan(out.findIndex((l) => l.includes('ct mark set 0x68766e74')))
    expect(out.findIndex((l) => l.includes('ct mark set 0x68766e74'))).toBeLessThan(out.findIndex((l) => l === `${cg} drop`))
    expect(out).toContain(`${cg} ip daddr 127.0.0.1 meta l4proto tcp ct state new ct mark != 0x68766e75 ct mark set 0x68766e74 accept`)
    // Fail closed: only connections this table marked may send. No bare loopback accept
    // (an unmarked or untracked connection, or a reply to a client outside the cgroup).
    expect(out).toContain(`${cg} ip daddr 127.0.0.1 meta l4proto tcp ct mark { 0x68766e74, 0x68766e75 } accept`)
    expect(out.some((l) => l === `${cg} ip daddr 127.0.0.1 meta l4proto tcp accept`)).toBe(false)
    // Only the loopback address: no other host, no UDP (no local DNS resolver).
    expect(out.filter((l) => l.includes(' accept') && l.startsWith(cg)).every((l) => l.includes('ip daddr 127.0.0.1') && /tcp/.test(l))).toBe(true)
    // In: a listener in the cgroup is checked and accepted; anything else on a marked connection is dropped.
    expect(inn).toContain(`iif "lo" ct mark 0x68766e74 ct direction original ${cg} ct mark set 0x68766e75 accept`)
    expect(inn).toContain('iif "lo" ct mark 0x68766e74 ct direction original drop')
    // Nothing outside the cgroup opens a connection to a tools listener (the browser's debugging port).
    expect(inn.filter((l) => l.startsWith('iif')).at(-1)).toBe(`iif "lo" ct direction original ct mark != { 0x68766e74, 0x68766e75 } ${cg} drop`)
  })
})

describe('enable-egress --prove (card #278)', () => {
  it('refuses to run as anyone but root, and never reads a failed cgroup join as "blocked"', async () => {
    const { PROVE } = await import('../scripts/hosted/enable-egress.js')
    // From 2026-11-05 to 1.84.4 the proof ran as havn, could not join the tools
    // cgroup, and printed "blocked" for every check.
    expect(PROVE).toContain('[ "$(id -u)" = 0 ] ||')
    expect(PROVE).toMatch(/inside\(\) \{ sh -c 'echo \$\$ > "\$0\/cgroup\.procs" \|\| exit 99; exec "\$@"'/)
    expect(PROVE).toContain('nothing was proven')
    expect(PROVE).toContain('inside true || exit 1')
    // Every network check goes through the guarded join; none joins on its own.
    for (const line of PROVE.split('\n').filter((l) => /curl|getent|\/dev\/tcp/.test(l) && !l.includes('outside'))) expect(line).toMatch(/inside /)
  })

  it('proves a tool cannot leave the fence, and that the join helper moves only the assistant in (card #307)', async () => {
    const { PROVE } = await import('../scripts/hosted/enable-egress.js')
    // A havn process in the tools cgroup tries both ways out; first a positive control.
    expect(PROVE).toContain('could not start a havn process in the tools cgroup: nothing was proven')
    expect(PROVE).toContain('inside, leaving the cgroup: MOVED OUT (a tool can leave the fence)')
    expect(PROVE).toContain('/sys/fs/cgroup/cgroup.procs')
    expect(PROVE).toContain('the join helper: moves a tool in')
    expect(PROVE).toContain('the join helper, asked from outside the assistant: refused')
    expect(PROVE).toContain('outside the cgroup: NO network, so the checks below would prove nothing"; exit 1')
    expect(PROVE).toContain('inside, ping: REPLIED (ICMP is NOT fenced)')
    expect(PROVE).toContain('havn.service: no root commands')
    // Cron, at and the user's systemd manager would run a tool's command outside the fence.
    expect(PROVE).toContain('inside, cron: TOOK A JOB (it would run outside the fence)"; exit 1')
    expect(PROVE).toContain('inside, at: TOOK A JOB (it would run outside the fence)"; exit 1')
    expect(PROVE).toContain('inside, the user\'s systemd: STARTED A JOB (outside the fence)"; exit 1')
    for (const l of PROVE.split('\n').filter((l) => /crontab -'|at now|systemd-run/.test(l))) expect(l).toMatch(/^if (command -v at >\/dev\/null && )?inside \$H /)
  })
})

describe('the root egress helper (card #307)', () => {
  it('setup installs it root-owned, drops Delegate and clears the cgroup on every start and stop', async () => {
    const { setupScript } = await import('../scripts/hosted/enable-egress.js')
    const s = setupScript('', '')
    expect(s).not.toContain('Delegate=yes')
    expect(s).not.toMatch(/chown havn/)
    expect(s).toContain('install -m 0755 -o root -g root /usr/local/lib/havn/egressd.py.new /usr/local/lib/havn/egressd.py')
    expect(s).toContain('install -m 0755 -o root -g root /usr/local/lib/havn/tools-join.new /usr/local/lib/havn/tools-join')
    expect(s).toContain('EGRESS_JOIN=/usr/local/lib/havn/tools-join')
    expect(s).toContain('EGRESS_CGROUP=/sys/fs/cgroup/havn-tools')
    expect(s).toContain('echo 1 > /sys/fs/cgroup/havn-tools/cgroup.kill')
    // The rule is replaced in one transaction and stays loaded while the assistant is down.
    expect(s).toContain('table inet havn_egress\ndelete table inet havn_egress\ntable inet havn_egress {')
    expect(s).not.toContain('nft delete table')
    expect(s).toContain('egress not set up')
    // No root command runs inside havn.service: it reads the assistant's editable .env (PATH, LD_PRELOAD).
    expect(s).not.toMatch(/^Exec[A-Za-z]*=[-@:!]*\+/m)
    expect(s).toContain('cat > /etc/systemd/system/havn-tools-guard.service')
    expect(s).toContain('PartOf=havn.service')
    expect(s).toContain('ExecStart=/usr/local/sbin/havn-egress-rules')
    expect(s).toContain('Requires=havn-tools-guard.service havn-egressd.service')
    expect(s).toContain('systemctl restart havn-egressd.service')
    expect(s).toContain('[ -S /run/havn-egress/sock ] || { echo "havn-egressd did not start"; exit 1; }')
    // Nothing that runs jobs for havn outside the fence stays open to it.
    expect(s).toContain("printf 'root\\n' > /etc/cron.allow")
    expect(s).toContain("printf 'root\\n' > /etc/at.allow")
    expect(s).toContain('crontab -r -u havn')
    expect(s).toContain('systemctl mask "user@$HU.service"')
  })

  it('runs with root-owned python, trusts the socket over the caller, and only ever moves a process in', () => {
    expect(EGRESSD_UNIT).toContain('ExecStart=/usr/bin/python3 -I -S /usr/local/lib/havn/egressd.py')
    expect(EGRESSD_UNIT).toContain('PrivateNetwork=yes')
    expect(EGRESSD_PY).toContain('SO_PEERCRED')
    expect(EGRESSD_PY).toContain("if uid != HAVN.pw_uid:")
    expect(EGRESSD_PY).toContain("uids_of(parent) != {HAVN.pw_uid}")
    // The parent is held by a pidfd and must be the same process after the move.
    expect(EGRESSD_PY).toContain('os.pidfd_open(parent)')
    // Only the wrapper shell is moved: a tool that execs the helper itself has the assistant as its parent.
    expect(EGRESSD_PY).toContain("SHELL = os.path.realpath('/bin/sh')")
    expect(EGRESSD_PY).toContain('if exe != SHELL:')
    expect(EGRESSD_PY).toContain('SLOTS = threading.BoundedSemaphore(32)')
    expect(EGRESSD_PY).toContain("if started(parent) != born or ppid_of(peer) != parent:")
    // The only cgroup.procs it ever writes is the tools cgroup's.
    expect(EGRESSD_PY.match(/cgroup\.procs/g)).toHaveLength(1)
    expect(EGRESSD_PY).toContain("open(TOOLS + '/cgroup.procs', 'w')")
    expect(EGRESSD_PY).toContain('os.chmod(SOCK, 0o660)')
    expect(JOIN_PY).toContain("s.sendall(b'join\\n')")
    expect(JOIN_PY).toContain('sys.exit(1)')
  })
})

describe('egress settings on a hosted box (card #307)', () => {
  it('takes them from the root-owned file, never from .env loaded into the service', async () => {
    const { pickEgressSettings } = await import('../src/config.js')
    const file = { EGRESS: 'enforce', EGRESS_CGROUP: '/sys/fs/cgroup/havn-tools', EGRESS_JOIN: '/usr/local/lib/havn/tools-join', EGRESS_ALLOW: '' }
    // systemd puts .env into the service's environment, so an edited .env shows up in process.env.
    const tampered = { EGRESS: 'off', EGRESS_JOIN: '/bin/true', EGRESS_ALLOW: 'evil.example' }
    expect(pickEgressSettings(file, tampered, {})).toMatchObject(file)
    // A key the file leaves out is not taken from .env either...
    expect(pickEgressSettings({ EGRESS: 'enforce' }, { EGRESS_JOIN: '/bin/true', EGRESS_ALLOW: 'evil.example' }, {})).toMatchObject({ EGRESS_JOIN: undefined, EGRESS_ALLOW: undefined })
    // ...except the cgroup, which boxes set up before 1.86.0 kept only in the drop-in.
    expect(pickEgressSettings({ EGRESS: 'enforce' }, { EGRESS_CGROUP: '/x' }, {}).EGRESS_CGROUP).toBe('/x')
    // No file: the environment, then .env, as before.
    expect(pickEgressSettings(null, {}, { EGRESS: 'enforce' }).EGRESS).toBe('enforce')
    expect(pickEgressSettings(null, { EGRESS: 'off' }, { EGRESS: 'enforce' }).EGRESS).toBe('off')
  })
})
