/**
 * What a box sends the off-box audit witness, and the rule the witness uses
 * to accept it (card #196, part 2). Shared by the box (witness.ts) and the
 * Cloudflare Worker (deploy/audit-witness), so it uses nothing but WebCrypto
 * and plain objects.
 *
 * The witness never sees what an event says, only that it existed: `detail`
 * (the command or path) is replaced by its SHA-256. The box keeps the full
 * line, so comparing the two still shows any edit. That was Marc's call on
 * 2026-10-12: client commands can carry message text, and the copy that
 * leaves the box should not.
 *
 * The witness checks linkage only (each event's prevHash is the previous
 * event's hash, seq has no gaps, and the first event continues the stored
 * head). It cannot recompute a hash without the detail, and does not need
 * to: its job is to remember, so the box's own verify can compare.
 */

export type ShippedEvent = {
  seq: number
  ts: string
  runId: string
  actor: string
  action: string
  outcome: string
  detailSha256: string
  prevHash: string
  hash: string
}

export type Head = { seq: number; hash: string }

export const GENESIS_HASH = '0'.repeat(64)
export const MAX_BATCH = 500
const HEX64 = /^[0-9a-f]{64}$/
const FIELD_MAX = 200

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The off-box form of a local audit event: same chain fields, detail fingerprinted. */
export async function fingerprint(e: { seq: number; ts: string; runId: string; actor: string; action: string; outcome: string; detail: string; prevHash: string; hash: string }): Promise<ShippedEvent> {
  return {
    seq: e.seq,
    ts: e.ts,
    runId: e.runId.slice(0, FIELD_MAX),
    actor: e.actor.slice(0, FIELD_MAX),
    action: e.action.slice(0, FIELD_MAX),
    outcome: e.outcome.slice(0, FIELD_MAX),
    detailSha256: await sha256Hex(e.detail),
    prevHash: e.prevHash,
    hash: e.hash,
  }
}

export type BatchCheck = { ok: true; head: Head } | { ok: false; status: 400 | 409; reason: string }

function wellFormed(e: unknown): e is ShippedEvent {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  const short = (v: unknown) => typeof v === 'string' && v.length <= FIELD_MAX
  return Number.isSafeInteger(o.seq) && (o.seq as number) > 0
    && short(o.ts) && short(o.runId) && short(o.actor) && short(o.action) && short(o.outcome)
    && typeof o.detailSha256 === 'string' && HEX64.test(o.detailSha256)
    && typeof o.prevHash === 'string' && HEX64.test(o.prevHash)
    && typeof o.hash === 'string' && HEX64.test(o.hash)
    && Object.keys(o).length === 9
}

/**
 * Accept a batch only if it continues `head` exactly. 400 is a malformed
 * request; 409 means the box's chain and the witness's disagree, which is
 * either a lost acknowledgement (the box can tell, see witness.ts) or a
 * rewritten or forked log.
 */
export function checkBatch(head: Head, events: unknown): BatchCheck {
  if (!Array.isArray(events) || events.length === 0) return { ok: false, status: 400, reason: 'events must be a non-empty array' }
  if (events.length > MAX_BATCH) return { ok: false, status: 400, reason: `at most ${MAX_BATCH} events per batch` }
  if (!events.every(wellFormed)) return { ok: false, status: 400, reason: 'malformed event' }
  let prev = head
  for (const e of events) {
    if (e.seq !== prev.seq + 1) return { ok: false, status: 409, reason: `expected seq ${prev.seq + 1}, got ${e.seq}` }
    if (e.prevHash !== prev.hash) return { ok: false, status: 409, reason: `event ${e.seq} does not link to ${prev.seq}` }
    prev = { seq: e.seq, hash: e.hash }
  }
  return { ok: true, head: prev }
}

/** Box names double as storage prefixes. */
export const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** R2 key for a batch: zero-padded so keys sort in chain order. */
export function batchKey(box: string, from: number, to: number): string {
  const pad = (n: number) => String(n).padStart(12, '0')
  return `boxes/${box}/${pad(from)}-${pad(to)}.jsonl`
}

/** The seq range a batch key covers, or null for a key that is not one. */
export function parseBatchKey(key: string): { from: number; to: number } | null {
  const m = /\/(\d{12})-(\d{12})\.jsonl$/.exec(key)
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null
}

// --- part 3: checks ---------------------------------------------------------

/** What a box's own check can find (witness-check.ts). */
export const CHECK_KINDS = ['conflict', 'backlog', 'broken', 'mismatch'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

/** A box's check report: `POST /v1/check`. Kinds only, no detail leaves the box. */
export type CheckReport = { ok: boolean; problems: CheckKind[]; full: boolean }

/** The report, rebuilt from known fields only, or null when it is not one. */
export function parseCheckReport(body: unknown): CheckReport | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  if (typeof o.ok !== 'boolean' || typeof o.full !== 'boolean' || !Array.isArray(o.problems) || o.problems.length > CHECK_KINDS.length) return null
  if (!o.problems.every((p) => (CHECK_KINDS as readonly unknown[]).includes(p))) return null
  const problems = [...new Set(o.problems as CheckKind[])]
  if (o.ok !== (problems.length === 0)) return null
  return { ok: o.ok, problems, full: o.full }
}

/** One box as the witness's admin status reports it. */
export type BoxStatus = {
  box: string
  head: Head
  issuedAt: string | null
  lastAppendAt: string | null
  conflicts: number
  /** Conflicts the operator has looked at (`POST /v1/admin/boxes/<box>/ack`). */
  conflictsAcked: number
  lastConflict: { at: string; reason: string } | null
  lastCheck: { at: string; ok: boolean; problems: CheckKind[] } | null
  lastFullCheckAt: string | null
}

export const SILENT_MS = 24 * 60 * 60_000
export const FULL_CHECK_STALE_MS = 48 * 60 * 60_000

/**
 * What the operator should hear about a box, in plain words. Shared by the
 * Worker's daily cron and anything that reads /v1/admin/status. A box checks
 * in every hour even when nothing happened on it, so 24 hours without an
 * append or a check means it stopped talking: the service is down, the
 * shipper is off, or someone turned it off. Conflicts keep being reported
 * until the operator acknowledges them.
 */
export function boxProblems(s: BoxStatus, now: number): string[] {
  const out: string[] = []
  const age = (iso: string | null) => (iso ? now - Date.parse(iso) : Infinity)
  const seen = Math.min(age(s.lastAppendAt), age(s.lastCheck?.at ?? null))
  const since = age(s.issuedAt)
  if (seen > SILENT_MS && since > SILENT_MS) {
    out.push(seen === Infinity ? 'has never sent anything' : `silent for ${Math.floor(seen / 3_600_000)} hours`)
  }
  if (s.conflicts > s.conflictsAcked) out.push(`${s.conflicts - s.conflictsAcked} unacknowledged conflict(s): ${s.lastConflict?.reason ?? 'chain mismatch'}`)
  if (s.lastCheck && !s.lastCheck.ok) out.push(`its own check reports: ${s.lastCheck.problems.join(', ')}`)
  if (s.lastCheck && age(s.lastFullCheckAt) > FULL_CHECK_STALE_MS && since > FULL_CHECK_STALE_MS) out.push('has not run a full check in 48 hours')
  return out
}
