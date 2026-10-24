/**
 * The egress proxy (card #231). One small forward proxy per run, on its own
 * loopback port, so the port says which run is calling and therefore which
 * policy applies. Tools find it through HTTP(S)_PROXY; on a hosted box the
 * kernel lets the tools' cgroup reach nothing but these ports (hosted.ts).
 *
 * Plain HTTP requests are checked with their method; an HTTPS CONNECT is
 * checked by host and port. Each redirect is a new request from the client,
 * so every hop is checked on its own. The policy is read per connection, so a
 * role change or revoked grant mid-run applies to the next connection.
 *
 * Names are resolved here, and a public name that resolves to an internal
 * address is refused (a DNS answer must not open the loopback or the cloud
 * metadata service). Every decision goes to `record`, normally the audit log.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { AddressInfo } from 'node:net'
import { decide, isInternalAddress, type EgressPolicy } from './policy.js'

export type EgressRecord = { method: string; host: string; port: number; path: string; decision: 'allowed' | 'denied'; reason?: string }

export interface RunProxyOptions {
  /** Read for every connection: the run's policy as it is now. */
  policy: () => EgressPolicy
  record?: (r: EgressRecord) => void
  /** Ports to bind in, inclusive, so a kernel rule can name them. Default: any free port. */
  ports?: [number, number]
  /** Tests: resolve names differently. */
  resolve?: (host: string) => Promise<string>
}

export interface RunProxy {
  url: string
  port: number
  close(): Promise<void>
}

async function defaultResolve(host: string): Promise<string> {
  return (await lookup(host)).address
}

/** The address to connect to, or why not. Literal addresses were already judged by the policy. */
async function target(host: string, opts: RunProxyOptions): Promise<{ addr: string } | { refused: string }> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) return { addr: bare }
  let addr: string
  try {
    addr = await (opts.resolve ?? defaultResolve)(bare)
  } catch {
    return { refused: `${bare} does not resolve` }
  }
  return isInternalAddress(addr) ? { refused: `${bare} resolves to an internal address (${addr})` } : { addr }
}

function splitHostPort(authority: string, fallback: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:]+)(?::(\d+))?$/.exec(authority)
  return m ? { host: m[1], port: m[2] ? Number(m[2]) : fallback } : { host: authority, port: fallback }
}

const HOP_HEADERS = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']

function deny(res: ServerResponse, reason: string): void {
  res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Havn-Egress': 'denied' })
  res.end(`egress denied: ${reason}\n`)
}

async function onRequest(req: IncomingMessage, res: ServerResponse, opts: RunProxyOptions): Promise<void> {
  let url: URL
  try {
    url = new URL(req.url ?? '')
  } catch {
    return deny(res, 'only absolute http:// URLs go through this proxy')
  }
  if (url.protocol !== 'http:') return deny(res, `${url.protocol} is not proxied in the clear; use https through CONNECT`)
  const port = url.port ? Number(url.port) : 80
  const method = req.method ?? 'GET'
  const host = url.hostname
  const rec = (decision: 'allowed' | 'denied', reason?: string) => opts.record?.({ method, host, port, path: url.pathname, decision, reason })
  const verdict = decide(opts.policy(), { host, port, method })
  if (!verdict.allow) { rec('denied', verdict.reason); return deny(res, verdict.reason) }
  const t = await target(host, opts)
  if ('refused' in t) { rec('denied', t.refused); return deny(res, t.refused) }
  rec('allowed')
  const headers = { ...req.headers }
  for (const h of HOP_HEADERS) delete headers[h]
  const upstream = httpRequest({ host: t.addr, port, method, path: url.pathname + url.search, headers: { ...headers, host: url.host } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`upstream error: ${err.message}\n`)
  })
  req.pipe(upstream)
}

async function onConnect(req: IncomingMessage, client: Socket, head: Buffer, opts: RunProxyOptions): Promise<void> {
  const { host, port } = splitHostPort(req.url ?? '', 443)
  const rec = (decision: 'allowed' | 'denied', reason?: string) => opts.record?.({ method: 'CONNECT', host, port, path: '', decision, reason })
  const refuse = (reason: string) => {
    rec('denied', reason)
    client.end(`HTTP/1.1 403 Forbidden\r\nX-Havn-Egress: denied\r\nContent-Type: text/plain\r\n\r\negress denied: ${reason}\n`)
  }
  const verdict = decide(opts.policy(), { host, port, method: null })
  if (!verdict.allow) return refuse(verdict.reason)
  const t = await target(host, opts)
  if ('refused' in t) return refuse(t.refused)
  rec('allowed')
  const upstream = connect(port, t.addr, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  const close = () => { upstream.destroy(); client.destroy() }
  upstream.on('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); close() })
  client.on('error', close)
  client.on('close', () => upstream.destroy())
}

async function listenInRange(server: Server, ports?: [number, number]): Promise<number> {
  const tryPort = (p: number) => new Promise<boolean>((resolveP) => {
    const onErr = () => { server.off('listening', onOk); resolveP(false) }
    const onOk = () => { server.off('error', onErr); resolveP(true) }
    server.once('error', onErr)
    server.once('listening', onOk)
    server.listen(p, '127.0.0.1')
  })
  if (!ports) {
    await tryPort(0)
    return (server.address() as AddressInfo).port
  }
  const [lo, hi] = ports
  const span = hi - lo + 1
  const start = Math.floor(Math.random() * span)
  for (let i = 0; i < span; i++) {
    const p = lo + ((start + i) % span)
    if (await tryPort(p)) return p
  }
  throw new Error(`no free egress proxy port in ${lo}-${hi}`)
}

export async function openRunProxy(opts: RunProxyOptions): Promise<RunProxy> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    req.on('error', () => res.destroy())
    res.on('error', () => {})
    onRequest(req, res, opts).catch((err) => { if (!res.headersSent) deny(res, `proxy error: ${String(err)}`) })
  })
  server.on('connect', (req, client: Socket, head) => {
    // The raw socket is ours from here, before any await: a client that resets
    // early must not raise an unhandled 'error' and take the assistant down.
    client.on('error', () => client.destroy())
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    onConnect(req, client, head, opts).catch(() => client.destroy())
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  server.on('clientError', (_err, s) => s.destroy())
  const port = await listenInRange(server, opts.ports)
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy()
      server.close(() => r())
    }),
  }
}
