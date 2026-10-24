/**
 * tests/assurance-space-adapter.test.ts
 *
 * Spike #225: the SPACE execution adapter without a SPACE endpoint. A fake
 * SPACE HTTP server stands in for the API and data plane, and a fake SpaceApi
 * stands in for the guest when the #218 cases run through the route. The live
 * run against the lab is tests/assurance-space-live.test.ts (SPACE_LIVE=1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CASES, DirectEgress, FIXTURE_ROLES, runCase, startMockWorld,
  type ContainmentCase, type Harness, type IndependentEvent, type MockWorld,
} from '../src/assurance/containment-eval.js'
import {
  DENY_ALL, HttpSpaceApi, SpaceRoute, checkOrigin, guestCommand, outcomeOf, sseFrames,
  type ExecOutcome, type NetworkPolicy, type SpaceApi,
} from '../src/assurance/space-adapter.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Hoisted: space-adapter.ts imports config, so the mock needs these before any import runs.
const { CWD, AUDIT, STORE, ROLES, mode } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'havn-space-'))
  const cwd = join(root, 'install')
  return { CWD: cwd, AUDIT: join(root, 'audit'), STORE: join(cwd, 'store'), ROLES: join(cwd, 'roles.json'), mode: { guard: 'log' } }
})

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>()
  return { ...actual, PROJECT_ROOT: CWD, STORE_DIR: STORE, AUDIT_DIR: AUDIT, ROLES_FILE: ROLES, get TOOL_GUARD() { return mode.guard } }
})

const b64 = (s: string) => Buffer.from(s).toString('base64')

// --- a fake guest -------------------------------------------------------------

class FakeSpace implements SpaceApi {
  creates: { name: string; policy: NetworkPolicy }[] = []
  runs: { sandboxId: string; argv: string[] }[] = []
  policies = new Map<string, NetworkPolicy>()
  deleted: string[] = []
  async createSandbox(req: { policy: NetworkPolicy; name: string }) {
    const id = `sbx_fake${this.creates.length}`
    this.creates.push(req)
    this.policies.set(id, req.policy)
    return { sandboxId: id, ms: 1 }
  }
  async run(sandboxId: string, argv: string[]): Promise<ExecOutcome> {
    this.runs.push({ sandboxId, argv })
    // The guest has none of the install's files, and egress is the gateway's call.
    return { exitCode: argv[2].startsWith('curl') ? 7 : 0, stdout: '', stderr: '', ms: 1 }
  }
  async setPolicy(id: string, p: NetworkPolicy) { this.policies.set(id, p) }
  async deleteSandbox(id: string) { this.deleted.push(id) }
}

let world: MockWorld
let gate: Harness['gate']

function readAudit(): (IndependentEvent & { actor: string })[] {
  const f = join(AUDIT, 'audit.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function auditLog() {
  const { AuditLog } = await import('../src/assurance/audit-log.js')
  return new AuditLog({ dir: AUDIT, workspace: CWD })
}

function harness(route: SpaceRoute): Harness {
  return {
    gate: (call) => gate(call),
    world,
    egress: new DirectEgress(),
    cwd: CWD,
    auditDir: AUDIT,
    evidenceFiles: [join(AUDIT, 'audit.jsonl'), join(STORE, 'tool-guard.jsonl'), join(STORE, 'role-log.jsonl')],
    prepare(c: ContainmentCase) {
      mode.guard = c.context.kind === 'chat' ? c.context.guard : 'log'
      writeFileSync(ROLES, JSON.stringify(FIXTURE_ROLES))
    },
    control(name: string) {
      const [verb, id] = name.split(':')
      if (verb === 'revoke-role') writeFileSync(ROLES, JSON.stringify(FIXTURE_ROLES.filter((r) => r.id !== id)))
    },
    readIndependentLog: readAudit,
    execute: (call, effects) => route.execute(call, effects),
  }
}

const byId = (id: string) => CASES.find((c) => c.id === id)!

beforeAll(async () => {
  mkdirSync(STORE, { recursive: true })
  writeFileSync(join(CWD, '.env'), 'FAKE_TOKEN=synthetic-value-not-a-secret\n')
  world = await startMockWorld()
  ;({ gateToolCall: gate } = await import('../src/assurance/scope-gate.js'))
})

afterAll(async () => {
  await world?.close()
})

describe('SpaceRoute behind the real gate', () => {
  const approved = () => [{ ip: '127.0.0.1' }]
  const grants = (r: string) => r === 'inbox-triage' ? { allow: [] } : r === 'temp-grant' ? { allow: approved(), expiresAt: '2026-01-01T00:00:00Z' } : { allow: approved() }

  it('a refused call never reaches the sandbox (C03, C10)', async () => {
    const api = new FakeSpace()
    const route = new SpaceRoute({ api, grantFor: grants })
    const h = harness(route)
    for (const id of ['C03', 'C10']) {
      const r = await runCase(byId(id), h)
      expect(r.attempts.every((a) => !a.allowed), id).toBe(true)
    }
    expect(api.runs).toEqual([])
    expect(api.creates).toEqual([])
  })

  it('one sandbox per run, with a default-deny policy for its role', async () => {
    const api = new FakeSpace()
    const route = new SpaceRoute({ api, grantFor: grants })
    await runCase(byId('C20'), harness(route)) // web-reader: first curl allowed, second refused by role
    await runCase(byId('C01'), harness(route)) // briefing
    expect(api.creates.map((c) => c.policy.egress.default_action)).toEqual(['deny', 'deny'])
    expect(api.creates[0].policy.egress.allow).toEqual([{ ip: '127.0.0.1' }])
    expect(api.runs).toHaveLength(2)
    expect(new Set(api.runs.map((r) => r.sandboxId)).size).toBe(2)
    expect(api.runs[0].argv.slice(0, 2)).toEqual(['sh', '-c'])
  })

  it('an expired grant never reaches SPACE: the gate refuses it first (C21, card #230)', async () => {
    const api = new FakeSpace()
    const route = new SpaceRoute({ api, grantFor: grants, now: () => new Date('2026-10-22T00:00:00Z') })
    const r = await runCase(byId('C21'), harness(route))
    expect(api.creates).toHaveLength(0)
    expect(r.attempts[0]).toMatchObject({ allowed: false, layer: 'role' })
  })

  it('the route still answers an expired grant with deny-all if one gets past the gate', () => {
    const route = new SpaceRoute({ api: new FakeSpace(), grantFor: grants, now: () => new Date('2026-10-22T00:00:00Z') })
    expect(route.policyFor('temp-grant')).toEqual(DENY_ALL)
  })

  it('a second AuditLog on the same file breaks the chain, so the route must share the gate\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'havn-space-audit-'))
    const { AuditLog } = await import('../src/assurance/audit-log.js')
    const a = new AuditLog({ dir, workspace: CWD })
    const b = new AuditLog({ dir, workspace: CWD })
    a.append({ runId: 'x', actor: 't', action: 'Bash', outcome: 'allowed', detail: '1' })
    b.append({ runId: 'x', actor: 't', action: 'space.dispatch', outcome: 'allowed', detail: '2' })
    a.append({ runId: 'x', actor: 't', action: 'Bash', outcome: 'allowed', detail: '3' })
    expect(new AuditLog({ dir, workspace: CWD }).verify().issues.length).toBeGreaterThan(0)
  })

  it('records dispatch and exit on the host, and the audit chain still verifies', async () => {
    const api = new FakeSpace()
    // Default audit: the gate's shared trail, so the chain stays one sequence.
    const route = new SpaceRoute({ api, grantFor: grants })
    const before = readAudit().length
    const r = await runCase(byId('L01'), harness(route))
    expect(r.verdict).toBe('PASS')
    const mine = readAudit().slice(before).filter((e) => e.runId === 'L01:direct')
    expect(mine.map((e) => e.action)).toEqual(['Bash', 'space.dispatch', 'space.exit'])
    expect(mine[1].detail).toContain('sbx=sbx_fake0')
    expect(mine[2].detail).toContain('exit=7')
    expect((await auditLog()).verify().issues).toEqual([])
  })

  it('only Bash moves by default; networkTools also moves WebFetch and browser fetches', async () => {
    expect(guestCommand('WebFetch', { url: 'http://a/x' }, false)).toBeNull()
    expect(guestCommand('Write', { file_path: 'output/x' }, true)).toBeNull()
    expect(guestCommand('WebFetch', { url: "http://a/x?y='1'" }, true)).toBe("curl -sS -L -m 10 'http://a/x?y='\\''1'\\'''")
    expect(guestCommand('mcp__playwright__browser_evaluate', { function: "() => fetch('http://u/form', {method: 'POST', body: 'e=1'})" }, true))
      .toBe("curl -sS -L -m 10 -X POST --data 'e=1' 'http://u/form'")
  })

  it('a sandbox that cannot be created means the command does not run anywhere', async () => {
    const api = new FakeSpace()
    api.createSandbox = async () => { throw new Error('no capacity') }
    const route = new SpaceRoute({ api, grantFor: grants })
    const r = await route.execute({ session: 's', tool: 'Bash', input: { command: 'echo hi' }, cwd: CWD }, [])
    expect(r?.output).toContain('sandbox unavailable, not run')
    expect(api.runs).toEqual([])
  })

  it('revoke swaps in deny-all, and dispose deletes every sandbox', async () => {
    const api = new FakeSpace()
    const route = new SpaceRoute({ api, grantFor: grants })
    await route.execute({ session: 'r1', tool: 'Bash', input: { command: 'true' }, cwd: CWD, scope: { role: 'briefing' } }, [])
    expect(await route.revoke('r1')).toBe(true)
    expect(api.policies.get('sbx_fake0')).toEqual(DENY_ALL)
    expect(await route.dispose()).toEqual([])
    expect(api.deleted).toEqual(['sbx_fake0'])
  })
})

// --- the HTTP client against a fake SPACE ----------------------------------------

describe('HttpSpaceApi', () => {
  let api: Server
  let data: Server
  let apiUrl = ''
  let dataUrl = ''
  let eventsUrl = (_id: string) => ''
  const seen: { path: string; auth?: string; key?: string }[] = []
  const MGMT = 'mgmt-token-synthetic'
  const ATTACH = 'attach-token-synthetic'

  beforeAll(async () => {
    api = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ path: req.url!, auth: req.headers.authorization, key: req.headers['idempotency-key'] as string })
        if (req.headers.authorization !== `Bearer ${MGMT}`) { res.writeHead(401); return res.end('{}') }
        const json = (v: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
        if (req.method === 'POST' && req.url === '/v1/sandboxes') return json({ sandbox_id: 'sbx_one', operation_id: 'op_one', echo: JSON.parse(body) })
        if (req.url === '/v1/operations/op_one') return json({ state: 'succeeded' })
        if (req.url === '/v1/sandboxes/sbx_one') return req.method === 'DELETE' ? json({}) : json({ state: 'running' })
        if (req.url?.startsWith('/v1/sandboxes/sbx_one/processes')) return json({ data: [] })
        if (req.url === '/v1/sandboxes/sbx_one/commands') return json({ session_id: 'proc_a', process_id: 'proc_a', attach: { events_url: eventsUrl('proc_a'), token: ATTACH } })
        if (req.url === '/v1/sandboxes/sbx_redirect/commands') { res.writeHead(307, { Location: 'http://127.0.0.1:9/steal' }); return res.end() }
        res.writeHead(404); res.end('{}')
      })
    })
    data = createServer((req, res) => {
      seen.push({ path: req.url!, auth: req.headers.authorization })
      if (req.headers.authorization !== `Bearer ${ATTACH}`) { res.writeHead(401); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`: hello\n\nevent: stdout\ndata: {"type":"stdout","data_base64":"${b64('hi\n')}"}\n\ndata: {"type":"process_exited","exit_code":3}\n\n`)
    })
    await Promise.all([api, data].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))))
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    dataUrl = `http://127.0.0.1:${(data.address() as AddressInfo).port}`
    eventsUrl = (id) => `/v1/sessions/${id}/events`
  })

  afterAll(async () => {
    await Promise.all([api, data].map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  it('creates with the policy, runs, and keeps the two tokens apart', async () => {
    const c = new HttpSpaceApi({ apiUrl, dataPlaneUrl: dataUrl, token: MGMT })
    const { sandboxId } = await c.createSandbox({ policy: DENY_ALL, name: 'n' })
    expect(sandboxId).toBe('sbx_one')
    const out = await c.run(sandboxId, ['sh', '-c', 'echo hi'])
    expect(out).toMatchObject({ exitCode: 3, stdout: 'hi\n', sessionId: 'proc_a' })
    expect(seen.find((s) => s.path === '/v1/sessions/proc_a/events')?.auth).toBe(`Bearer ${ATTACH}`)
    expect(seen.filter((s) => s.path.startsWith('/v1/sandboxes')).every((s) => s.auth === `Bearer ${MGMT}`)).toBe(true)
    expect(seen.find((s) => s.path === '/v1/sandboxes')?.key).toMatch(/^havn-create-/)
  })

  it('refuses an events URL at another origin', async () => {
    eventsUrl = (id) => `http://127.0.0.1:1/v1/sessions/${id}/events`
    const c = new HttpSpaceApi({ apiUrl, dataPlaneUrl: dataUrl, token: MGMT })
    await expect(c.run('sbx_one', ['true'])).rejects.toThrow(/unexpected events URL/)
    eventsUrl = (id) => `/v1/sessions/${id}/events`
  })

  it('never follows a redirect with a token', async () => {
    const c = new HttpSpaceApi({ apiUrl, dataPlaneUrl: dataUrl, token: MGMT })
    await expect(c.run('sbx_redirect', ['true'])).rejects.toThrow(/refusing to follow a 307/)
  })

  it('allows plain HTTP only to loopback or a private lab address', () => {
    expect(checkOrigin('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080')
    expect(checkOrigin('https://space.example.test')).toBe('https://space.example.test')
    expect(() => checkOrigin('http://space.example.test')).toThrow(/use HTTPS/)
  })

  it('a stream without process_exited is not a success', () => {
    expect(outcomeOf(sseFrames(`data: {"type":"stdout","data_base64":"${b64('x')}"}\n\n`), 1).error).toBe('stream ended without process_exited')
    expect(() => sseFrames('data: {"type":"stdout"')).toThrow(/incomplete/)
  })
})
