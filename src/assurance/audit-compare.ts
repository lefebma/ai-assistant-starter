/**
 * Compare a box's audit log with the witness's copy, event by event (card
 * #196, part 4). This is the operator's tool after an alert, or in a drill:
 * it runs on the operator's machine, never trusting the box's own code.
 *
 * The witness holds every event's chain fields and a SHA-256 of its detail.
 * That is enough to say, for each event the witness holds, whether the box
 * still has it unchanged, has it edited, or lost it; and for each event only
 * the box has, that it was never sent (an ordinary backlog, or a fabrication
 * written after the witness stopped accepting). It is not enough to bring back
 * a lost detail: the recovered record says who did what kind of thing and
 * when, and proves the detail it had, but not what it said.
 */
import { createHash } from 'node:crypto'
import { hashOf, type AuditEvent } from './audit-log.js'
import { GENESIS_HASH, type ShippedEvent } from './witness-protocol.js'

export type CompareReport = {
  witnessEvents: number
  localEvents: number
  /** The witness's own chain links from genesis without a gap. */
  witnessChainOk: boolean
  witnessChainIssue?: string
  matched: number
  /** Present locally but different from what the witness holds. */
  edited: number[]
  /** Held by the witness, gone from the box. */
  missing: number[]
  /** Only on the box: never accepted by the witness. */
  unsent: number[]
  /** Local lines that are not events. */
  unreadable: number
  ok: boolean
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function parseLocal(text: string): { events: AuditEvent[]; unreadable: number } {
  const events: AuditEvent[] = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as AuditEvent)
    } catch {
      unreadable++
    }
  }
  return { events, unreadable }
}

export function compareLogs(localText: string, witness: ShippedEvent[]): CompareReport {
  const { events: local, unreadable } = parseLocal(localText)
  const report: CompareReport = {
    witnessEvents: witness.length, localEvents: local.length, witnessChainOk: true,
    matched: 0, edited: [], missing: [], unsent: [], unreadable, ok: false,
  }

  let prev = { seq: 0, hash: GENESIS_HASH }
  for (const w of witness) {
    if (w.seq !== prev.seq + 1 || w.prevHash !== prev.hash) {
      report.witnessChainOk = false
      report.witnessChainIssue = `witness chain breaks at seq ${w.seq}`
      break
    }
    prev = { seq: w.seq, hash: w.hash }
  }

  // The first local event per seq. A wiped-and-restarted log repeats seqs;
  // the one that lines up with the witness is the one that matters.
  const bySeq = new Map<number, AuditEvent[]>()
  for (const e of local) bySeq.set(e.seq, [...(bySeq.get(e.seq) ?? []), e])
  const witnessSeqs = new Set(witness.map((w) => w.seq))

  for (const w of witness) {
    const candidates = bySeq.get(w.seq)
    if (!candidates?.length) { report.missing.push(w.seq); continue }
    const same = candidates.some((l) => {
      const { hash, ...rest } = l
      return hash === w.hash && hashOf(rest) === hash && sha256(l.detail ?? '') === w.detailSha256
        && l.prevHash === w.prevHash && l.ts === w.ts && l.actor.slice(0, 200) === w.actor && l.action.slice(0, 200) === w.action && l.outcome === w.outcome
    })
    if (same) report.matched++
    else report.edited.push(w.seq)
  }
  const head = witness.length ? witness[witness.length - 1].seq : 0
  for (const e of local) {
    if (e.seq > head) report.unsent.push(e.seq)
    else if (!witnessSeqs.has(e.seq)) report.unsent.push(e.seq)
  }
  // A local log that restarted from seq 1 after a wipe shows up as extra
  // copies of seqs the witness holds; count each surplus copy as unsent.
  for (const [seq, copies] of bySeq) if (witnessSeqs.has(seq) && copies.length > 1) for (let i = 1; i < copies.length; i++) report.unsent.push(seq)
  report.unsent.sort((a, b) => a - b)

  report.ok = report.witnessChainOk && report.edited.length === 0 && report.missing.length === 0 && report.unreadable === 0
  return report
}

/** Ranges like "3-7, 9" for a report line. */
export function ranges(seqs: number[]): string {
  const out: string[] = []
  for (let i = 0; i < seqs.length; i++) {
    let j = i
    while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j++
    out.push(i === j ? `${seqs[i]}` : `${seqs[i]}-${seqs[j]}`)
    i = j
  }
  return out.join(', ')
}
