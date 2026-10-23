/**
 * Six synthetic workflows for spike #219, run through the audit log twice:
 *   - as today's runtime records them (audit-trail.ts: tool calls only, keyed
 *     by session id), into the baseline log;
 *   - with outcome spans (outcome-trace.ts), into the trace log.
 *
 * Every name, address and token count here is invented. The mailbox is a
 * stand-in destination the verifier reads directly, never through the model.
 */
import { join } from 'node:path'
import { AuditLog } from './audit-log.js'
import { AuditTrail, withActor } from './audit-trail.js'
import type { Obligation, Verdict } from './obligations.js'
import { OutcomeTracer, reconstruct, verdictFromLog, type SpanEnd, type SpanKind, type SpanRef, type Trace } from './outcome-trace.js'

export const PRICES = {
  'synthetic-large': { in: 3, out: 15 },
  'synthetic-small': { in: 0.8, out: 4 },
}

/** The destination. A send that the provider dropped never shows up here. */
export class MockMailbox {
  private sent = new Map<string, { to: string }>()
  deliver(id: string, to: string): void { this.sent.set(id, { to }) }
  has(id: string): boolean { return this.sent.has(id) }
}

/** Reads the destination itself. Returns evidence ids for what is really there. */
export function verifyMailbox(box: MockMailbox, expected: string[]): string[] {
  return expected.filter(id => box.has(id)).map(id => `mailbox:${id}`)
}

export function evidenceType(ev: string): { type: string; obligationId: string } | null {
  if (ev.startsWith('mailbox:')) return { type: 'email.delivered', obligationId: 'delivered' }
  if (ev.startsWith('approval:')) return { type: 'approval.granted', obligationId: 'approved' }
  return null
}

export type ScenarioResult = {
  traceLog: AuditLog
  baselineLog: AuditLog
  traces: Map<string, Trace>
  verdicts: Map<string, Verdict>
  obligations: Map<string, Obligation[]>
  /** Claims the model made about its own work that the checker refused. */
  refused: Map<string, number>
}

class Clock {
  t = Date.UTC(2026, 9, 22, 13, 0, 0)
  now = () => this.t
  tick(ms: number): void { this.t += ms }
}

const delivered = (n = 1): Obligation => ({ id: 'delivered', description: 'Email is in the recipient mailbox', evidenceType: 'email.delivered', minCount: n })
const approved: Obligation = { id: 'approved', description: 'Owner approved the draft', evidenceType: 'approval.granted' }

/** Run all six workflows. `base` must be a scratch directory. */
export function runScenarios(base: string): ScenarioResult {
  const workspace = join(base, 'workspace')
  const clock = new Clock()
  const traceDir = join(base, 'audit-trace')
  let traceLog = new AuditLog({ dir: traceDir, workspace })
  const baselineLog = new AuditLog({ dir: join(base, 'audit-baseline'), workspace })
  const trail = new AuditTrail(baselineLog)
  const box = new MockMailbox()
  const obligations = new Map<string, Obligation[]>()
  let tr = new OutcomeTracer(traceLog, clock.now, 'chat:owner')

  // One span, start and end, with the clock moving `ms` inside it.
  const span = (traceId: string, kind: SpanKind, name: string, parent: SpanRef | undefined, ms: number, end: SpanEnd, t = tr): SpanRef => {
    const ref = t.start(traceId, kind, name, parent)
    clock.tick(ms)
    t.end(ref, kind, name, end)
    return ref
  }
  // What audit-trail.ts records today for the same tool call.
  const today = (session: string, actor: string, tool: string, input: unknown, outcome: 'allowed' | 'blocked' = 'allowed') =>
    withActor(actor, () => trail.record({ session, tool, input }, outcome))

  function model(tokensIn: number, tokensOut: number, name = 'synthetic-large'): SpanEnd {
    return { status: 'ok', model: name, tokensIn, tokensOut }
  }

  // 1. success ---------------------------------------------------------------
  {
    const id = 'wf-success'
    obligations.set(id, [delivered()])
    const root = tr.start(id, 'request', 'send-invoice-reminder')
    span(id, 'authorize', 'role:assistant scope:email.send', root, 5, { status: 'ok' })
    span(id, 'model', 'plan', root, 4200, model(5200, 380))
    today('sess-1', 'chat:owner', 'mcp__gmail__send', { to: 'x', subject: 'y', body: 'z' })
    span(id, 'tool', 'gmail.send', root, 900, { status: 'ok' })
    box.deliver('msg-1', 'client-a@example.test')
    span(id, 'model', 'confirm', root, 1800, model(5900, 120))
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-1']) })
    tr.end(root, 'request', 'send-invoice-reminder', { status: 'ok' })
    clock.tick(60_000)
  }

  // 2. partial failure: three sends, the third fails after two retries ------
  {
    const id = 'wf-partial'
    obligations.set(id, [delivered(3)])
    const root = tr.start(id, 'request', 'send-three-followups')
    span(id, 'authorize', 'role:assistant scope:email.send', root, 5, { status: 'ok' })
    span(id, 'model', 'plan', root, 5100, model(6100, 640))
    for (const [i, to] of ['b', 'c'].entries()) {
      today('sess-2', 'chat:owner', 'mcp__gmail__send', { to, body: 'z' })
      span(id, 'tool', 'gmail.send', root, 800, { status: 'ok' })
      box.deliver(`msg-2${i}`, `${to}@example.test`)
    }
    for (const attempt of [1, 2, 3]) {
      today('sess-2', 'chat:owner', 'mcp__gmail__send', { to: 'd', body: 'z' })
      span(id, 'tool', 'gmail.send', root, 1200, { status: 'error', attempt, note: 'provider 503' })
      span(id, 'model', 'retry-decision', root, 1500, model(6800, 90))
    }
    // The model reports success anyway; recorded as a model claim, refused.
    span(id, 'model', 'final-reply', root, 1600, { ...model(7000, 150), evidence: ['mailbox:msg-22'] })
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-20', 'msg-21', 'msg-22']) })
    tr.end(root, 'request', 'send-three-followups', { status: 'error' })
    clock.tick(60_000)
  }

  // 3. human approval -------------------------------------------------------
  {
    const id = 'wf-approval'
    obligations.set(id, [approved, delivered()])
    const root = tr.start(id, 'request', 'reply-to-supplier')
    span(id, 'authorize', 'role:assistant scope:email.draft', root, 5, { status: 'ok' })
    span(id, 'model', 'draft', root, 6400, model(8100, 720))
    today('sess-3', 'chat:owner', 'mcp__gmail__create_draft', { to: 'x', body: 'z' })
    span(id, 'tool', 'gmail.create_draft', root, 700, { status: 'ok' })
    // The approval is the owner's button click, minted by the app, not the model.
    span(id, 'human_wait', 'approve-send', root, 3 * 3600_000 + 20 * 60_000, { status: 'ok', evidence: ['approval:click-3'] })
    span(id, 'authorize', 'approval:click-3 scope:email.send', root, 5, { status: 'ok' })
    today('sess-3', 'chat:owner', 'mcp__gmail__send_draft', { draftId: 'd' })
    span(id, 'tool', 'gmail.send_draft', root, 600, { status: 'ok' })
    box.deliver('msg-3', 'supplier@example.test')
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-3']) })
    tr.end(root, 'request', 'reply-to-supplier', { status: 'ok' })
    clock.tick(60_000)
  }

  // 4. subagent handoff -----------------------------------------------------
  {
    const id = 'wf-subagent'
    obligations.set(id, [delivered()])
    const root = tr.start(id, 'request', 'research-then-brief')
    span(id, 'authorize', 'role:assistant scope:web,email.send', root, 5, { status: 'ok' })
    span(id, 'model', 'plan', root, 3900, model(5000, 300))
    const sub = tr.start(id, 'subagent', 'dispatch_subagent', root)
    const subTr = new OutcomeTracer(traceLog, clock.now, 'subagent:research')
    span(id, 'model', 'research', sub, 9000, model(14000, 1100, 'synthetic-small'), subTr)
    // ai-sdk builds the subagent without guardSession, so today its tool calls
    // land under `ai-sdk:<cwd>`, not the parent session.
    today('ai-sdk:/synthetic/workspace', 'chat:owner', 'WebFetch', { url: 'https://example.test/report' })
    span(id, 'tool', 'web.fetch', sub, 2100, { status: 'ok' }, subTr)
    span(id, 'model', 'summarise', sub, 4300, model(16000, 600, 'synthetic-small'), subTr)
    tr.end(sub, 'subagent', 'dispatch_subagent', { status: 'ok' })
    today('sess-4', 'chat:owner', 'mcp__gmail__send', { to: 'x', body: 'z' })
    span(id, 'tool', 'gmail.send', root, 900, { status: 'ok' })
    box.deliver('msg-4', 'owner@example.test')
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-4']) })
    tr.end(root, 'request', 'research-then-brief', { status: 'ok' })
    clock.tick(60_000)
  }

  // 5. restart: the process dies after the send, before anything is checked --
  {
    const id = 'wf-restart'
    obligations.set(id, [delivered()])
    tr = new OutcomeTracer(traceLog, clock.now, 'job:digest')
    const root = tr.start(id, 'request', 'weekly-digest-email')
    span(id, 'authorize', 'role:digest scope:email.send', root, 5, { status: 'ok' })
    span(id, 'model', 'compose', root, 7200, model(9000, 900))
    today('sess-5a', 'job:digest', 'mcp__gmail__send', { to: 'x', body: 'z' })
    span(id, 'tool', 'gmail.send', root, 900, { status: 'ok' })
    box.deliver('msg-5', 'owner@example.test')
    // Crash. Nothing in memory survives: tracer, obligation checker, session.
    clock.tick(4 * 60_000)
    traceLog = new AuditLog({ dir: traceDir, workspace })
    tr = new OutcomeTracer(traceLog, clock.now, 'job:digest')
    // The scheduler starts a new session; the workflow id comes from the task row.
    span(id, 'orchestration', 'resume', root, 50, { status: 'ok' })
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-5']) })
    tr.end(root, 'request', 'weekly-digest-email', { status: 'ok' })
    clock.tick(60_000)
  }

  // 6. missing evidence: the tool said ok, the provider dropped it ----------
  {
    const id = 'wf-missing'
    obligations.set(id, [delivered()])
    tr = new OutcomeTracer(traceLog, clock.now, 'chat:owner')
    const root = tr.start(id, 'request', 'confirm-booking')
    span(id, 'authorize', 'role:assistant scope:email.send', root, 5, { status: 'ok' })
    span(id, 'model', 'plan', root, 3600, model(4800, 260))
    today('sess-6', 'chat:owner', 'mcp__gmail__send', { to: 'x', body: 'z' })
    span(id, 'tool', 'gmail.send', root, 900, { status: 'ok' })
    // No box.deliver: the send never landed. A second tool span never closed.
    tr.start(id, 'tool', 'calendar.create', root)
    clock.tick(1500)
    span(id, 'model', 'final-reply', root, 1400, { ...model(5600, 140), evidence: ['mailbox:msg-6'] })
    span(id, 'verify', 'mailbox', root, 300, { status: 'ok', evidence: verifyMailbox(box, ['msg-6']) })
    tr.end(root, 'request', 'confirm-booking', { status: 'ok' })
  }

  const events = traceLog.eventsAfter(0)
  const traces = reconstruct(events)
  const verdicts = new Map<string, Verdict>()
  const refused = new Map<string, number>()
  for (const [id, obs] of obligations) {
    const r = verdictFromLog(id, obs, events, evidenceType)
    verdicts.set(id, r.verdict)
    refused.set(id, r.refused)
  }
  return { traceLog, baselineLog, traces, verdicts, obligations, refused }
}
