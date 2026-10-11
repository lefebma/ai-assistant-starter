/**
 * Conflicting-record inference and abstention evaluation (card 172).
 *
 * A synthetic account (Whitfield Dental) spread across CRM, email, call notes
 * and transactions, with explicit facts, implied facts, stale records,
 * near-duplicates and direct contradictions. Each question has a ground-truth
 * status. The agent must answer with one of confirmed / inferred / conflicting
 * / unknown, cite the records it relied on, and flag review when evidence is
 * thin or materially inconsistent.
 *
 * This file is the harness: fixture, prompt, tolerant parser and scorer. It is
 * agent-agnostic (runEval takes any async reconciler), so the same suite grades
 * Havn, a baseline, or a regression run. All data is synthetic.
 */

export type Source = 'crm' | 'email' | 'call-note' | 'transaction'
export type SourceRecord = { id: string; source: Source; date: string; text: string }

export type Status = 'confirmed' | 'inferred' | 'conflicting' | 'unknown'
export type Kind = 'explicit' | 'implied' | 'stale' | 'near-duplicate' | 'contradiction' | 'missing' | 'insufficient'

export type Question = {
  id: string
  kind: Kind
  question: string
  expected: { status: Status; /** Normalised answer; null when no single answer is supportable. */ value: string | null; mustCite: string[] }
}

export type Answer = { questionId: string; status: Status; value: string | null; sources: string[]; needsReview: boolean }

export const RECORDS: SourceRecord[] = [
  { id: 'crm-1', source: 'crm', date: '2026-03-02', text: 'Account: Whitfield Dental. Primary contact: Dana Whitfield <dana@whitfielddental.example>. Phone: 416-555-0142.' },
  { id: 'crm-2', source: 'crm', date: '2024-05-14', text: 'Whitfield Dental, main line 416-555-0199 (old office).' },
  { id: 'crm-3', source: 'crm', date: '2026-01-20', text: 'Whitfield Dental. Contract: Managed Services, annual value $24,000.' },
  { id: 'crm-4', source: 'crm', date: '2026-01-22', text: 'Whitfield Dental Group, 88 King St. Contract: Managed Services, annual value $24,000.' },
  { id: 'crm-5', source: 'crm', date: '2026-02-10', text: 'Whitfield Dental renewal date: 2026-11-30. Billing: invoice INV-204, $1,500 marked paid.' },
  { id: 'em-1', source: 'email', date: '2026-04-11', text: 'From dana@whitfielddental.example: Thanks for the update. (Dana Whitfield, Whitfield Dental)' },
  { id: 'em-2', source: 'email', date: '2026-09-03', text: 'From dana@whitfielddental.example: Heads up, our renewal is on January 31, 2027, not November.' },
  { id: 'em-3', source: 'email', date: '2026-09-04', text: 'To dana@whitfielddental.example: Attached is the expansion proposal for your review.' },
  { id: 'em-4', source: 'email', date: '2026-09-05', text: 'From accounting@whitfielddental.example: Re November renewal, we will confirm the date after our board meets.' },
  { id: 'cn-1', source: 'call-note', date: '2026-08-19', text: 'Call with Dana. New direct line is 416-555-0177, the 0199 office line is closed. Happy with service.' },
  { id: 'tx-1', source: 'transaction', date: '2026-06-01', text: 'Payment received from Whitfield Dental, invoice INV-204, $1,200.00, ACH.' },
  { id: 'tx-2', source: 'transaction', date: '2026-07-01', text: 'Payment received from Whitfield Dental, invoice INV-231, $2,000.00, ACH.' },
]

export const QUESTIONS: Question[] = [
  { id: 'q1', kind: 'explicit', question: "What is Dana Whitfield's email address?", expected: { status: 'confirmed', value: 'dana@whitfielddental.example', mustCite: ['crm-1', 'em-1'] } },
  { id: 'q2', kind: 'implied', question: 'Is Whitfield Dental a paying customer?', expected: { status: 'inferred', value: 'yes', mustCite: ['tx-1'] } },
  { id: 'q3', kind: 'stale', question: "What is Dana's current direct phone number?", expected: { status: 'confirmed', value: '416-555-0177', mustCite: ['cn-1'] } },
  { id: 'q4', kind: 'near-duplicate', question: "What is Whitfield Dental's annual contract value?", expected: { status: 'inferred', value: '$24,000', mustCite: ['crm-3', 'crm-4'] } },
  { id: 'q5', kind: 'contradiction', question: "When is Whitfield Dental's renewal date?", expected: { status: 'conflicting', value: null, mustCite: ['crm-5', 'em-2'] } },
  { id: 'q6', kind: 'missing', question: "What is Whitfield Dental's annual revenue?", expected: { status: 'unknown', value: null, mustCite: [] } },
  { id: 'q7', kind: 'insufficient', question: 'Has Dana read the expansion proposal?', expected: { status: 'unknown', value: null, mustCite: ['em-3'] } },
  { id: 'q8', kind: 'contradiction', question: 'How much was paid on invoice INV-204?', expected: { status: 'conflicting', value: null, mustCite: ['crm-5', 'tx-1'] } },
]

export function buildPrompt(records = RECORDS, questions = QUESTIONS): string {
  return [
    'You are reconciling records for one customer account. Use ONLY the records below.',
    'For each question return an object: {"questionId","status","value","sources","needsReview"}.',
    'status is one of: confirmed (stated directly by current records), inferred (follows from the records but is not stated), conflicting (records materially disagree and recency does not settle it), unknown (not enough evidence).',
    'value is your answer, or null for conflicting/unknown. sources lists the record ids you relied on. Set needsReview true when evidence is insufficient or materially inconsistent. Do not guess.',
    'Return a JSON array only.',
    '', 'RECORDS:', ...records.map(r => `[${r.id}] (${r.source}, ${r.date}) ${r.text}`),
    '', 'QUESTIONS:', ...questions.map(q => `${q.id}: ${q.question}`),
  ].join('\n')
}

const STATUSES: ReadonlySet<string> = new Set(['confirmed', 'inferred', 'conflicting', 'unknown'])

/** Tolerant: accepts bare JSON or a fenced block; drops malformed entries. */
export function parseAnswers(text: string): Answer[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const body = fenced ?? text
  const start = body.indexOf('['), end = body.lastIndexOf(']')
  if (start < 0 || end < start) return []
  let raw: unknown
  try { raw = JSON.parse(body.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: Answer[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.questionId !== 'string' || typeof r.status !== 'string' || !STATUSES.has(r.status)) continue
    out.push({
      questionId: r.questionId,
      status: r.status as Status,
      value: typeof r.value === 'string' ? r.value : null,
      sources: Array.isArray(r.sources) ? r.sources.filter((s): s is string => typeof s === 'string') : [],
      needsReview: r.needsReview === true,
    })
  }
  return out
}

const norm = (v: string | null) => (v ?? '').toLowerCase().replace(/[\s,]/g, '')

export type QuestionScore = {
  questionId: string
  correct: boolean
  /** Share of required citations present. 1 when none are required. */
  evidenceCoverage: number
  /** Overconfident (committed to a value where the truth is conflicting/unknown), cited nothing, or cited records that do not exist. */
  unsupported: boolean
  fabricatedCitations: string[]
  abstained: boolean
  shouldAbstain: boolean
}

export type EvalScore = {
  perQuestion: QuestionScore[]
  reconciliationAccuracy: number
  evidenceCoverage: number
  unsupportedConclusions: number
  /** Of questions that should abstain, share where the agent abstained. */
  abstentionRecall: number
  /** Of questions that should be answered, share where it abstained anyway. */
  overAbstentionRate: number
}

export function score(answers: Answer[], questions = QUESTIONS, records = RECORDS): EvalScore {
  const ids = new Set(records.map(r => r.id))
  const byQ = new Map(answers.map(a => [a.questionId, a]))
  const per: QuestionScore[] = questions.map(q => {
    const a = byQ.get(q.id)
    const shouldAbstain = q.expected.status === 'conflicting' || q.expected.status === 'unknown'
    if (!a) return { questionId: q.id, correct: false, evidenceCoverage: 0, unsupported: false, fabricatedCitations: [], abstained: false, shouldAbstain }
    const fabricated = a.sources.filter(s => !ids.has(s))
    const abstained = a.status === 'conflicting' || a.status === 'unknown' || a.needsReview
    const committed = (a.status === 'confirmed' || a.status === 'inferred') && a.value !== null
    const need = q.expected.mustCite
    const coverage = need.length === 0 ? 1 : need.filter(id => a.sources.includes(id)).length / need.length
    const statusOk = a.status === q.expected.status
    const valueOk = q.expected.value === null ? a.value === null : norm(a.value) === norm(q.expected.value)
    const unsupported = fabricated.length > 0 || (committed && shouldAbstain) || (committed && a.sources.length === 0)
    return { questionId: q.id, correct: statusOk && valueOk, evidenceCoverage: coverage, unsupported, fabricatedCitations: fabricated, abstained, shouldAbstain }
  })
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1)
  const abst = per.filter(p => p.shouldAbstain), ans = per.filter(p => !p.shouldAbstain)
  return {
    perQuestion: per,
    reconciliationAccuracy: mean(per.map(p => (p.correct ? 1 : 0))),
    evidenceCoverage: mean(per.map(p => p.evidenceCoverage)),
    unsupportedConclusions: per.filter(p => p.unsupported).length,
    abstentionRecall: mean(abst.map(p => (p.abstained ? 1 : 0))),
    overAbstentionRate: ans.length ? ans.filter(p => p.abstained).length / ans.length : 0,
  }
}

/** Run any agent against the fixture. The reconciler gets the prompt and returns raw text. */
export async function runEval(reconciler: (prompt: string) => Promise<string>): Promise<EvalScore> {
  return score(parseAnswers(await reconciler(buildPrompt())))
}
