/**
 * Ships the audit log to the off-box witness (card #196, part 2).
 *
 * The append-only audit.jsonl is the outbox: every few minutes the shipper
 * reads the events after the last one the witness acknowledged, sends them
 * fingerprinted (witness-protocol.ts), and records the new acknowledgement in
 * witness-state.json beside the log. A witness outage never touches a tool
 * call; the backlog just waits.
 *
 * A 409 means the chains disagree. If the witness is merely ahead of our
 * acknowledgement with an event we also hold (the reply to an earlier send was
 * lost), the shipper catches up and carries on. Anything else is recorded as a
 * conflict and shipping stops until someone looks: the local log was rewritten,
 * or something else is writing as this box. Part 3 alerts on it.
 *
 * Configured by AUDIT_WITNESS_URL (.env) and the AUDIT_WITNESS_TOKEN secret,
 * both written by `npm run witness-token`. Off when either is missing.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuditLog, type AuditEvent } from './audit-log.js'
import { GENESIS_HASH, MAX_BATCH, fingerprint, type Head } from './witness-protocol.js'
import { logger } from '../logger.js'

export type WitnessState = {
  ackedSeq: number
  ackedHash: string
  /** Byte offset in audit.jsonl just past the acknowledged event. */
  offset: number
  lastOkAt?: string
  lastError?: string
  lastErrorAt?: string
  conflict?: { at: string; reason: string; witnessHead?: Head }
}

export type ShipResult = { shipped: number; state: WitnessState }

const FRESH: WitnessState = { ackedSeq: 0, ackedHash: GENESIS_HASH, offset: 0 }

export function witnessStatePath(auditDir: string): string {
  return join(auditDir, 'witness-state.json')
}

export function readWitnessState(path: string): WitnessState {
  try {
    return { ...FRESH, ...(JSON.parse(readFileSync(path, 'utf-8')) as Partial<WitnessState>) }
  } catch {
    return { ...FRESH }
  }
}

function saveState(path: string, state: WitnessState): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export class WitnessShipper {
  private log: AuditLog
  private url: string
  private token: string
  private statePath: string
  private fetchImpl: typeof fetch
  private batch: number

  constructor(opts: { log: AuditLog; url: string; token: string; statePath?: string; fetchImpl?: typeof fetch; batch?: number }) {
    this.log = opts.log
    this.url = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.statePath = opts.statePath ?? witnessStatePath(opts.log.dir)
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.batch = Math.min(opts.batch ?? 200, MAX_BATCH)
  }

  /** Where the log continues after `seq`, by scanning; -1 when the log no longer holds it. */
  private offsetAfter(seq: number): number {
    if (seq === 0) return 0
    let offset = 0
    for (;;) {
      const { events, ends } = this.log.readFrom(offset, 5000)
      if (!events.length) return -1
      const i = events.findIndex((e) => e.seq === seq)
      if (i !== -1) return ends[i]
      offset = ends[ends.length - 1]
    }
  }

  private size(): number {
    try { return statSync(this.log.file).size } catch { return 0 }
  }

  /**
   * Pending events, starting exactly after the acknowledged one. When the log
   * no longer holds the acknowledged event (it shrank, or was replaced), the
   * start of the log is sent as it is, so the witness answers 409 and the
   * conflict is recorded rather than shipping going quiet.
   */
  private pending(state: WitnessState): { events: AuditEvent[]; ends: number[] } {
    let read = state.offset <= this.size() ? this.log.readFrom(state.offset, this.batch) : { events: [], ends: [] }
    const misplaced = state.offset > this.size() || (read.events.length > 0 && read.events[0].seq !== state.ackedSeq + 1)
    if (misplaced) {
      const at = this.offsetAfter(state.ackedSeq)
      if (at === -1) return this.log.readFrom(0, this.batch)
      state.offset = at
      read = this.log.readFrom(at, this.batch)
    }
    // Keep only the contiguous run that continues the acknowledgement.
    let n = 0
    while (n < read.events.length && read.events[n].seq === state.ackedSeq + 1 + n) n++
    return { events: read.events.slice(0, n), ends: read.ends.slice(0, n) }
  }

  async shipOnce(): Promise<ShipResult> {
    const state = readWitnessState(this.statePath)
    let shipped = 0
    if (state.conflict) return { shipped, state }
    const fail = (msg: string): ShipResult => {
      state.lastError = msg
      state.lastErrorAt = new Date().toISOString()
      saveState(this.statePath, state)
      return { shipped, state }
    }
    for (;;) {
      const { events, ends } = this.pending(state)
      if (!events.length) break
      let res: Response
      try {
        res = await this.fetchImpl(`${this.url}/v1/append`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events: await Promise.all(events.map(fingerprint)) }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        return fail(`witness unreachable: ${String(err)}`)
      }
      const body = (await res.json().catch(() => ({}))) as { head?: Head; error?: string }
      if (res.ok && body.head) {
        const last = events.length - 1
        state.ackedSeq = events[last].seq
        state.ackedHash = events[last].hash
        state.offset = ends[last]
        state.lastOkAt = new Date().toISOString()
        delete state.lastError
        delete state.lastErrorAt
        shipped += events.length
        saveState(this.statePath, state)
        continue
      }
      if (res.status === 409 && body.head) {
        const w = body.head
        // The witness already holds events we sent but never heard back about.
        const i = events.findIndex((e) => e.seq === w.seq)
        const held = i !== -1 ? events[i] : w.seq > state.ackedSeq ? this.log.eventsAfter(w.seq - 1)[0] : undefined
        if (held && held.seq === w.seq && held.hash === w.hash && w.seq > state.ackedSeq) {
          state.ackedSeq = w.seq
          state.ackedHash = w.hash
          state.offset = i !== -1 ? ends[i] : Math.max(0, this.offsetAfter(w.seq))
          saveState(this.statePath, state)
          continue
        }
        state.conflict = { at: new Date().toISOString(), reason: body.error ?? 'chain mismatch', witnessHead: w }
        logger.error({ witnessHead: w, ackedSeq: state.ackedSeq }, 'audit witness rejected the chain: the local log and the witness disagree')
        saveState(this.statePath, state)
        return { shipped, state }
      }
      return fail(`witness answered ${res.status}: ${body.error ?? ''}`.trim())
    }
    if (shipped) saveState(this.statePath, state)
    return { shipped, state }
  }
}

/**
 * Ship every `intervalMs` (first run after `firstMs`). Never overlaps itself,
 * never throws. Returns a stop function.
 */
export function startWitnessShipping(make: () => WitnessShipper | null, intervalMs = 5 * 60_000, firstMs = 30_000): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const shipper = make()
      if (shipper) {
        const r = await shipper.shipOnce()
        if (r.shipped) logger.info({ shipped: r.shipped, acked: r.state.ackedSeq }, 'audit events sent to the witness')
        else if (r.state.lastError) logger.warn({ error: r.state.lastError }, 'audit witness: send failed, will retry')
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'audit witness: shipping failed, will retry')
    } finally {
      running = false
    }
  }
  const first = setTimeout(() => void tick(), firstMs)
  const timer = setInterval(() => void tick(), intervalMs)
  first.unref?.()
  timer.unref?.()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
