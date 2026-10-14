/**
 * Card #196, part 2: the off-box witness. The real Worker code runs against an
 * in-memory stand-in for Durable Objects and a locked R2 bucket, and the box's
 * shipper talks to it through a fetch that calls the Worker directly.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import worker, { BoxWitness, dailyReport, type Env } from '../deploy/audit-witness/worker.js'
import { AuditLog } from '../src/assurance/audit-log.js'
import { WitnessShipper, readWitnessState } from '../src/assurance/witness.js'
import { GENESIS_HASH, checkBatch, fingerprint, sha256Hex, batchKey, parseBatchKey, parseCheckReport, boxProblems, type BoxStatus } from '../src/assurance/witness-protocol.js'
import { WitnessChecker, OWNER_MESSAGES, checkStatePath } from '../src/assurance/witness-check.js'

const ADMIN = 'admin-secret-token'

function makeEnv(): Env & { objects: Map<string, string> } {
  const objects = new Map<string, string>()
  const instances = new Map<string, BoxWitness>()
  const env = {
    objects,
    ADMIN_TOKEN_SHA256: '',
    BUCKET: {
      async put(key: string, value: string) {
        if (objects.has(key)) throw new Error('object is locked')
        objects.set(key, value)
      },
      async get(key: string) {
        const v = objects.get(key)
        return v === undefined ? null : { key, text: async () => v }
      },
      async list({ prefix }: { prefix: string }) {
        return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }
      },
    },
    WITNESS: {
      idFromName: (name: string) => name,
      get(id: unknown) {
        const name = id as string
        let inst = instances.get(name)
        if (!inst) {
          const store = new Map<string, unknown>()
          inst = new BoxWitness({
            storage: { get: async (k: string) => structuredClone(store.get(k)) as never, put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) },
            blockConcurrencyWhile: (fn) => fn(),
          }, env as unknown as Env)
          instances.set(name, inst)
        }
        return inst
      },
    },
  }
  return env as unknown as Env & { objects: Map<string, string> }
}

const call = (env: Env, path: string, token: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://witness.test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }), env)

async function issue(env: Env, box: string): Promise<string> {
  const r = await call(env, `/v1/admin/boxes/${box}/token`, ADMIN, { method: 'POST' })
  expect(r.status).toBe(200)
  return ((await r.json()) as { token: string }).token
}

let root: string, auditDir: string, workspace: string, env: Env & { objects: Map<string, string> }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'witness-'))
  auditDir = join(root, 'audit')
  workspace = join(root, 'ws'); mkdirSync(workspace)
  env = makeEnv()
  env.ADMIN_TOKEN_SHA256 = await sha256Hex(ADMIN)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const add = (log: AuditLog, n: number, detail = 'cmd') => {
  for (let i = 0; i < n; i++) log.append({ runId: 'r', actor: 'chat:1', action: 'Bash', outcome: 'allowed', detail: `${detail} ${i}` })
}
const shipperFor = (log: AuditLog, token: string, batch = 200) =>
  new WitnessShipper({ log, url: 'https://witness.test/', token, batch, fetchImpl: ((u: string, init: RequestInit) => worker.fetch(new Request(u, init), env)) as typeof fetch })

describe('witness protocol', () => {
  it('accepts only a batch that continues the head', async () => {
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 3)
    const shipped = await Promise.all(log.eventsAfter(0).map(fingerprint))
    expect(checkBatch({ seq: 0, hash: GENESIS_HASH }, shipped)).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(checkBatch({ seq: 0, hash: GENESIS_HASH }, shipped.slice(1))).toMatchObject({ ok: false, status: 409 })
    expect(checkBatch({ seq: 0, hash: GENESIS_HASH }, [shipped[0], shipped[2]])).toMatchObject({ ok: false, status: 409 })
    expect(checkBatch({ seq: 0, hash: GENESIS_HASH }, [{ ...shipped[0], extra: 1 }])).toMatchObject({ ok: false, status: 400 })
    expect(checkBatch({ seq: 0, hash: GENESIS_HASH }, [])).toMatchObject({ ok: false, status: 400 })
  })

  it('ships a fingerprint of the detail, never the text', async () => {
    const log = new AuditLog({ dir: auditDir, workspace })
    log.append({ runId: 'r', actor: 'chat:1', action: 'Bash', outcome: 'allowed', detail: 'gog gmail drafts create --body "private words"' })
    const [e] = await Promise.all(log.eventsAfter(0).map(fingerprint))
    expect(JSON.stringify(e)).not.toContain('private words')
    expect(e.detailSha256).toBe(await sha256Hex('gog gmail drafts create --body "private words"'))
  })

  it('keys sort in chain order', () => {
    expect(batchKey('box', 2, 10) < batchKey('box', 11, 12)).toBe(true)
    expect(parseBatchKey(batchKey('box', 7, 9))).toEqual({ from: 7, to: 9 })
  })
})

describe('witness Worker', () => {
  it('refuses missing, wrong and cross-box tokens, and admin routes to boxes', async () => {
    const a = await issue(env, 'box-a')
    await issue(env, 'box-b')
    expect((await worker.fetch(new Request('https://witness.test/v1/head'), env)).status).toBe(401)
    expect((await call(env, '/v1/head', 'box-a.wrong')).status).toBe(401)
    expect((await call(env, '/v1/head', `box-b.${a.split('.')[1]}`)).status).toBe(401)
    expect((await call(env, '/v1/admin/status', a)).status).toBe(401)
    expect((await call(env, '/v1/head', a)).status).toBe(200)
  })

  it('has no route that deletes or rewrites', async () => {
    const a = await issue(env, 'box-a')
    for (const [method, path] of [['DELETE', '/v1/events'], ['PUT', '/v1/append'], ['POST', '/v1/reset'], ['POST', '/issue'], ['GET', '/status']]) {
      expect((await call(env, path, a, { method })).status).toBe(404)
    }
  })

  it('a reissued token replaces the old one', async () => {
    const first = await issue(env, 'box-a')
    const second = await issue(env, 'box-a')
    expect((await call(env, '/v1/head', first)).status).toBe(401)
    expect((await call(env, '/v1/head', second)).status).toBe(200)
  })
})

describe('shipping a box log to the witness', () => {
  it('ships in batches, resumes from its offset, and the witness holds the same chain', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 7)
    const s = shipperFor(log, token, 3)
    expect((await s.shipOnce()).shipped).toBe(7)
    expect(env.objects.size).toBe(3)
    add(log, 2)
    const r = await s.shipOnce()
    expect(r.shipped).toBe(2)
    expect(r.state).toMatchObject({ ackedSeq: 9, ackedHash: log.headOf().hash })
    const head = (await (await call(env, '/v1/head', token)).json()) as { head: { seq: number; hash: string } }
    expect(head.head).toEqual(log.headOf())
    const events = (await (await call(env, '/v1/events?from=1', token)).json()) as { events: { seq: number; hash: string }[] }
    expect(events.events.map((e) => e.hash)).toEqual(log.eventsAfter(0).map((e) => e.hash))
    // Nothing readable left the box.
    expect([...env.objects.values()].join('')).not.toContain('cmd 1')
  })

  it('sends nothing when there is nothing new', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    expect((await shipperFor(log, token).shipOnce()).shipped).toBe(0)
  })

  it('catches up after a lost acknowledgement instead of crying conflict', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 4)
    const s = shipperFor(log, token)
    await s.shipOnce()
    // The reply never arrived: the box still thinks nothing was acknowledged.
    writeFileSync(join(auditDir, 'witness-state.json'), JSON.stringify({ ackedSeq: 0, ackedHash: GENESIS_HASH, offset: 0 }))
    add(log, 1)
    const r = await s.shipOnce()
    expect(r.state.conflict).toBeUndefined()
    expect(r.state.ackedSeq).toBe(5)
  })

  it('stops with a conflict when the local log was rewritten', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 3)
    await shipperFor(log, token).shipOnce()
    // Root clears the log and the box starts a fresh chain.
    rmSync(auditDir, { recursive: true, force: true })
    rmSync(join(root, 'ws-state'), { force: true })
    const fresh = new AuditLog({ dir: auditDir, workspace })
    add(fresh, 2, 'innocent')
    const r = await shipperFor(fresh, token).shipOnce()
    expect(r.state.conflict?.witnessHead?.seq).toBe(3)
    expect(readWitnessState(join(auditDir, 'witness-state.json')).conflict).toBeTruthy()
    const status = (await (await call(env, '/v1/admin/status', ADMIN)).json()) as { boxes: { box: string; conflicts: number }[] }
    expect(status.boxes).toEqual([expect.objectContaining({ box: 'box-a', conflicts: 1 })])
    // And it stays stopped.
    expect((await shipperFor(fresh, token).shipOnce()).shipped).toBe(0)
  })

  it('flags a wiped log even when the shipping state survived', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 5)
    await shipperFor(log, token).shipOnce()
    writeFileSync(join(auditDir, 'audit.jsonl'), '') // as root, after chattr -a
    const fresh = new AuditLog({ dir: auditDir, workspace })
    add(fresh, 1, 'after wipe')
    const r = await shipperFor(fresh, token).shipOnce()
    expect(r.state.conflict).toBeTruthy()
  })

  it('flags a log replaced by a longer forgery', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    await shipperFor(log, token).shipOnce()
    rmSync(join(auditDir, 'audit.jsonl'))
    const forged = new AuditLog({ dir: auditDir, workspace })
    add(forged, 6, 'forged')
    const r = await shipperFor(forged, token).shipOnce()
    expect(r.state.conflict).toBeTruthy()
  })

  it('records an unreachable witness and retries next time', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    const down = new WitnessShipper({ log, url: 'https://witness.test', token, fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch })
    const r = await down.shipOnce()
    expect(r.state.lastError).toMatch(/unreachable/)
    expect((await shipperFor(log, token).shipOnce()).shipped).toBe(2)
    expect(readWitnessState(join(auditDir, 'witness-state.json')).lastError).toBeUndefined()
  })

  it('skips a torn line and keeps the offset right', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    const file = join(auditDir, 'audit.jsonl')
    writeFileSync(file, readFileSync(file, 'utf-8') + '{"seq":3,"ts":"to')
    const reopened = new AuditLog({ dir: auditDir, workspace })
    add(reopened, 2)
    const r = await shipperFor(reopened, token).shipOnce()
    expect(r.shipped).toBe(4)
    expect(r.state.ackedHash).toBe(reopened.headOf().hash)
  })
})

describe('checks (part 3)', () => {
  const HOUR = 3_600_000
  const checkerFor = (log: AuditLog, token: string, now: () => number, sent: string[] = []) =>
    new WitnessChecker({
      log, url: 'https://witness.test', token, now,
      notify: async (t) => { sent.push(t); return true },
      fetchImpl: ((u: string, init: RequestInit) => worker.fetch(new Request(u, init), env)) as typeof fetch,
    })
  const status = async () => ((await (await call(env, '/v1/admin/status', ADMIN)).json()) as { boxes: (BoxStatus & { problems: string[] })[] }).boxes

  it('a healthy box reports ok and tells nobody', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 3)
    await shipperFor(log, token).shipOnce()
    const sent: string[] = []
    const r = await checkerFor(log, token, Date.now, sent).checkOnce()
    expect(r.report).toEqual({ ok: true, problems: [], full: true })
    expect(sent).toEqual([])
    const [b] = await status()
    expect(b.lastCheck).toMatchObject({ ok: true, problems: [] })
    expect(b.lastFullCheckAt).toBeTruthy()
    expect(b.problems).toEqual([])
  })

  it('catches an event edited after it was shipped, which shipping alone misses', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 3)
    await shipperFor(log, token).shipOnce()
    const file = join(auditDir, 'audit.jsonl')
    writeFileSync(file, readFileSync(file, 'utf-8').replace('cmd 1', 'cmd X')) // as root
    const edited = new AuditLog({ dir: auditDir, workspace })
    expect((await shipperFor(edited, token).shipOnce()).state.conflict).toBeUndefined()
    const sent: string[] = []
    const r = await checkerFor(edited, token, Date.now, sent).checkOnce()
    expect(r.report.problems).toContain('broken')
    expect(sent).toContain(OWNER_MESSAGES.broken)
    expect((await status())[0].problems).toEqual(['its own check reports: broken'])
  })

  it('catches a log cut back behind the witness', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 4)
    await shipperFor(log, token).shipOnce()
    const file = join(auditDir, 'audit.jsonl')
    writeFileSync(file, readFileSync(file, 'utf-8').split('\n').slice(0, 2).join('\n') + '\n')
    const r = await checkerFor(new AuditLog({ dir: auditDir, workspace }), token, Date.now).checkOnce()
    expect(r.report.problems).toContain('mismatch')
    expect(r.notes.mismatch).toMatch(/witness holds event 4/)
  })

  it('tells the owner about a conflict once, then again a day later, and stops when it clears', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 1)
    await shipperFor(log, token).shipOnce()
    writeFileSync(join(auditDir, 'witness-state.json'), JSON.stringify({ ...readWitnessState(join(auditDir, 'witness-state.json')), conflict: { at: 'x', reason: 'expected seq 2, got 1' } }))
    let t = Date.now()
    const sent: string[] = []
    const c = checkerFor(log, token, () => t, sent)
    await c.checkOnce()
    t += HOUR; await c.checkOnce()
    expect(sent).toEqual([OWNER_MESSAGES.conflict])
    t += 24 * HOUR; await c.checkOnce()
    expect(sent).toHaveLength(2)
    writeFileSync(join(auditDir, 'witness-state.json'), JSON.stringify({ ...readWitnessState(join(auditDir, 'witness-state.json')), conflict: undefined }))
    t += HOUR
    expect((await c.checkOnce()).report.ok).toBe(true)
    expect(JSON.parse(readFileSync(checkStatePath(auditDir), 'utf-8')).alerted).toEqual({})
  })

  it('flags a backlog older than an hour, not a fresh one', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    const now = Date.now()
    expect((await checkerFor(log, token, () => now).checkOnce()).report.problems).not.toContain('backlog')
    const later = await checkerFor(log, token, () => now + 2 * HOUR).checkOnce()
    expect(later.report.problems).toContain('backlog')
  })

  it('keeps a full-check problem open between full checks', async () => {
    const token = await issue(env, 'box-a')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    await shipperFor(log, token).shipOnce()
    const file = join(auditDir, 'audit.jsonl')
    writeFileSync(file, readFileSync(file, 'utf-8').replace('cmd 0', 'cmd Z'))
    let t = Date.now()
    const c = checkerFor(new AuditLog({ dir: auditDir, workspace }), token, () => t)
    expect((await c.checkOnce()).report).toMatchObject({ full: true, problems: ['broken'] })
    t += HOUR
    expect((await c.checkOnce()).report).toMatchObject({ full: false, problems: ['broken'] })
  })

  it('a box takes only well-formed reports, kinds only', async () => {
    expect(parseCheckReport({ ok: true, problems: [], full: false })).toEqual({ ok: true, problems: [], full: false })
    expect(parseCheckReport({ ok: true, problems: ['broken'], full: false })).toBeNull()
    expect(parseCheckReport({ ok: false, problems: ['rm -rf'], full: false })).toBeNull()
    expect(parseCheckReport({ ok: false, problems: ['broken'], full: true, conflicts: 0 })).toEqual({ ok: false, problems: ['broken'], full: true })
    const token = await issue(env, 'box-a')
    expect((await call(env, '/v1/check', token, { method: 'POST', body: '{"ok":"yes"}' })).status).toBe(400)
    expect((await call(env, '/v1/check', 'box-a.nope', { method: 'POST', body: '{"ok":true,"problems":[],"full":false}' })).status).toBe(401)
  })
})

describe('operator view (part 3)', () => {
  const HOUR = 3_600_000
  const base: BoxStatus = { box: 'b', head: { seq: 1, hash: GENESIS_HASH }, issuedAt: null, lastAppendAt: null, conflicts: 0, conflictsAcked: 0, lastConflict: null, lastCheck: null, lastFullCheckAt: null }
  const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString()

  it('flags silence, unacknowledged conflicts, failed and stale checks', () => {
    const now = Date.now()
    expect(boxProblems({ ...base, issuedAt: ago(1) }, now)).toEqual([])
    expect(boxProblems({ ...base, issuedAt: ago(30) }, now)).toEqual(['has never sent anything'])
    expect(boxProblems({ ...base, lastAppendAt: ago(30), lastCheck: { at: ago(25), ok: true, problems: [] }, lastFullCheckAt: ago(25) }, now)).toEqual(['silent for 25 hours'])
    expect(boxProblems({ ...base, lastAppendAt: ago(30), lastCheck: { at: ago(1), ok: true, problems: [] }, lastFullCheckAt: ago(2) }, now)).toEqual([])
    expect(boxProblems({ ...base, lastCheck: { at: ago(1), ok: false, problems: ['mismatch'] }, lastFullCheckAt: ago(1) }, now)).toEqual(['its own check reports: mismatch'])
    expect(boxProblems({ ...base, lastCheck: { at: ago(1), ok: true, problems: [] }, lastFullCheckAt: ago(50) }, now)).toEqual(['has not run a full check in 48 hours'])
    expect(boxProblems({ ...base, lastCheck: { at: ago(1), ok: true, problems: [] }, lastFullCheckAt: ago(1), conflicts: 2, conflictsAcked: 1, lastConflict: { at: ago(1), reason: 'expected seq 5, got 1' } }, now))
      .toEqual(['1 unacknowledged conflict(s): expected seq 5, got 1'])
  })

  it('ack clears a conflict from the report and retire stops watching a box', async () => {
    const token = await issue(env, 'box-a')
    await issue(env, 'smoke-1')
    const log = new AuditLog({ dir: auditDir, workspace })
    add(log, 2)
    await shipperFor(log, token).shipOnce()
    await call(env, '/v1/append', token, { method: 'POST', body: JSON.stringify({ events: await Promise.all(log.eventsAfter(0).map(fingerprint)) }) })
    const later = Date.now() + 30 * HOUR
    expect(await dailyReport(env, later)).toMatch(/box-a: 1 unacknowledged conflict/)
    expect(await dailyReport(env, later)).toMatch(/smoke-1: has never sent anything/)
    expect(((await (await call(env, '/v1/admin/boxes/box-a/ack', ADMIN, { method: 'POST' })).json()) as { conflictsAcked: number }).conflictsAcked).toBe(1)
    expect((await call(env, '/v1/admin/boxes/smoke-1/retire', ADMIN, { method: 'POST' })).status).toBe(200)
    expect(await dailyReport(env, later)).toBe('Audit witness: 1 problem(s)\n- box-a: silent for 30 hours')
    expect((await call(env, '/v1/admin/boxes/box-a/ack', token, { method: 'POST' })).status).toBe(401)
  })
})
