import { describe, it, expect } from 'vitest'
import { QUESTIONS, RECORDS, buildPrompt, parseAnswers, score, runEval, type Answer } from '../src/assurance/reconcile-eval.js'

const perfect: Answer[] = QUESTIONS.map(q => ({
  questionId: q.id, status: q.expected.status, value: q.expected.value, sources: [...q.expected.mustCite],
  needsReview: q.expected.status === 'conflicting' || q.expected.status === 'unknown',
}))

describe('conflicting-record evaluation (card 172)', () => {
  it('fixture covers every record source and every evidence kind', () => {
    expect(new Set(RECORDS.map(r => r.source))).toEqual(new Set(['crm', 'email', 'call-note', 'transaction']))
    expect(new Set(QUESTIONS.map(q => q.kind))).toEqual(new Set(['explicit', 'implied', 'stale', 'near-duplicate', 'contradiction', 'missing', 'insufficient']))
    expect(new Set(QUESTIONS.map(q => q.expected.status))).toEqual(new Set(['confirmed', 'inferred', 'conflicting', 'unknown']))
  })

  it('every required citation exists in the fixture', () => {
    const ids = new Set(RECORDS.map(r => r.id))
    for (const q of QUESTIONS) for (const c of q.expected.mustCite) expect(ids.has(c), `${q.id}:${c}`).toBe(true)
  })

  it('perfect answers score perfectly', () => {
    expect(score(perfect)).toMatchObject({ reconciliationAccuracy: 1, evidenceCoverage: 1, unsupportedConclusions: 0, abstentionRecall: 1, overAbstentionRate: 0 })
  })

  it('an overconfident agent is caught: unsupported conclusions and missed abstention', () => {
    const bold: Answer[] = QUESTIONS.map(q => ({ questionId: q.id, status: 'confirmed', value: q.expected.value ?? 'something', sources: ['crm-1'], needsReview: false }))
    const s = score(bold)
    expect(s.unsupportedConclusions).toBe(4) // q5, q6, q7, q8
    expect(s.abstentionRecall).toBe(0)
    expect(s.reconciliationAccuracy).toBeLessThan(0.5)
  })

  it('an agent that abstains on everything is caught for over-abstention', () => {
    const timid: Answer[] = QUESTIONS.map(q => ({ questionId: q.id, status: 'unknown', value: null, sources: [], needsReview: true }))
    const s = score(timid)
    expect(s.abstentionRecall).toBe(1)
    expect(s.overAbstentionRate).toBe(1)
    expect(s.reconciliationAccuracy).toBeLessThan(0.5)
  })

  it('a stale record cited instead of the current one is wrong and low coverage', () => {
    const a = perfect.map(x => (x.questionId === 'q3' ? { ...x, value: '416-555-0199', sources: ['crm-2'] } : x))
    const q3 = score(a).perQuestion.find(p => p.questionId === 'q3')!
    expect(q3.correct).toBe(false)
    expect(q3.evidenceCoverage).toBe(0)
  })

  it('fabricated citations count as unsupported even when the value is right', () => {
    const a = perfect.map(x => (x.questionId === 'q1' ? { ...x, sources: [...x.sources, 'crm-999'] } : x))
    const q1 = score(a).perQuestion.find(p => p.questionId === 'q1')!
    expect(q1.fabricatedCitations).toEqual(['crm-999'])
    expect(q1.unsupported).toBe(true)
  })

  it('a missing answer is a miss, not a pass', () => {
    const s = score(perfect.slice(1))
    expect(s.perQuestion[0].correct).toBe(false)
    expect(s.reconciliationAccuracy).toBeCloseTo(7 / 8)
  })

  it('parses fenced and bare JSON and drops malformed entries', () => {
    const json = JSON.stringify([...perfect.slice(0, 2), { questionId: 'q9', status: 'maybe' }, 'junk'])
    expect(parseAnswers('```json\n' + json + '\n```')).toHaveLength(2)
    expect(parseAnswers('Here you go: ' + json)).toHaveLength(2)
    expect(parseAnswers('no json at all')).toEqual([])
  })

  it('prompt carries every record and question and no ground truth', () => {
    const p = buildPrompt()
    for (const r of RECORDS) expect(p).toContain(`[${r.id}]`)
    for (const q of QUESTIONS) expect(p).toContain(q.question)
    expect(p).not.toMatch(/mustCite|expected/)
  })

  it('runEval grades any reconciler end to end', async () => {
    const s = await runEval(async prompt => {
      expect(prompt).toContain('RECORDS:')
      return '```json\n' + JSON.stringify(perfect) + '\n```'
    })
    expect(s.reconciliationAccuracy).toBe(1)
  })
})
