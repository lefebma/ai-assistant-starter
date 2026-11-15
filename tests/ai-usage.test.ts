/**
 * Month-to-date spend and the 80% heads-up on a managed box (card #159).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AI_USAGE_FILE,
  claudeTurnCostUsd,
  markUsageWarned,
  nextUtcMonthStart,
  readAiUsage,
  recordManagedSpend,
  usageWarningDue,
  usageWarningText,
} from '../src/ai-usage.js'
import { FIRST_REPLY, MANAGED_AI_FILE, REPEAT_REPLY, ownerPauseReply } from '../src/ai-limit.js'

const OCT = new Date('2026-10-20T15:00:00Z')

function store(flag: Record<string, unknown> | null = { since: '2026-10-01T00:00:00.000Z', capUsd: 50 }) {
  const d = mkdtempSync(join(tmpdir(), 'ai-usage-'))
  if (flag) writeFileSync(join(d, MANAGED_AI_FILE), JSON.stringify(flag))
  return d
}

describe('claudeTurnCostUsd', () => {
  const usage = (over: Record<string, number>) => ({
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, ...over,
  })
  // A real short turn from the B4 test on havn-test: the SDK reported $0.5064, Anthropic charged about $0.20.
  const b4Turn = usage({ inputTokens: 4, outputTokens: 213, cacheCreationInputTokens: 80173, costUSD: 0.5064 })

  it('prices Sonnet 5.5 at its published rate, not the figure the SDK reports', () => {
    expect(claudeTurnCostUsd({ total_cost_usd: 0.5064, modelUsage: { 'claude-sonnet-5-5': b4Turn } })).toBeCloseTo(0.20257, 5)
  })

  it('charges cache reads and web searches', () => {
    const u = usage({ cacheReadInputTokens: 1_000_000, webSearchRequests: 3, costUSD: 9 })
    expect(claudeTurnCostUsd({ total_cost_usd: 9, modelUsage: { 'claude-sonnet-5-5': u } })).toBeCloseTo(0.2 + 0.03, 6)
  })

  it('matches a dated or 1M-context model id', () => {
    const modelUsage = { 'claude-sonnet-5-5-20261001[1m]': b4Turn }
    expect(claudeTurnCostUsd({ total_cost_usd: 0.5064, modelUsage })).toBeCloseTo(0.20257, 5)
  })

  it('keeps the reported cost of a model it has no price for, adding the rest', () => {
    const haiku = usage({ outputTokens: 62, cacheCreationInputTokens: 27524, costUSD: 0.035 })
    const cost = claudeTurnCostUsd({ total_cost_usd: 0.5414, modelUsage: { 'claude-sonnet-5-5': b4Turn, 'claude-haiku-4-5-20251001': haiku } })
    expect(cost).toBeCloseTo(0.20257 + 0.035, 5)
  })

  it('falls back to the total without usable per-model figures', () => {
    expect(claudeTurnCostUsd({ total_cost_usd: 0.25 })).toBe(0.25)
    expect(claudeTurnCostUsd({ total_cost_usd: 0.25, modelUsage: {} })).toBe(0.25)
    expect(claudeTurnCostUsd({ total_cost_usd: 0.25, modelUsage: { 'claude-haiku-4-5': { costUSD: 'x' } } })).toBe(0.25)
    expect(claudeTurnCostUsd({ total_cost_usd: 0.25, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 'x' } } })).toBe(0.25)
  })
})

describe('recordManagedSpend', () => {
  let d: string
  beforeEach(() => {
    d = store()
  })

  it('adds each call to the UTC month and copies the cap', () => {
    recordManagedSpend(0.1, { storeDir: d, now: OCT })
    recordManagedSpend(0.25, { storeDir: d, now: OCT })
    expect(readAiUsage(d)).toEqual({ month: '2026-10', usd: 0.35, capUsd: 50 })
  })

  it('starts fresh in a new month and forgets last month\'s heads-up', () => {
    recordManagedSpend(45, { storeDir: d, now: OCT })
    markUsageWarned(d, OCT)
    recordManagedSpend(1, { storeDir: d, now: new Date('2026-11-01T00:00:05Z') })
    expect(readAiUsage(d)).toEqual({ month: '2026-11', usd: 1, capUsd: 50 })
  })

  it('ignores zero, negative and non-numbers, and never throws', () => {
    for (const v of [0, -1, NaN, undefined, '0.5', null]) recordManagedSpend(v, { storeDir: d, now: OCT })
    expect(readAiUsage(d)).toBeNull()
    writeFileSync(join(d, AI_USAGE_FILE), '{oops')
    expect(() => recordManagedSpend(0.5, { storeDir: d, now: OCT })).not.toThrow()
    expect(readAiUsage(d)).toEqual({ month: '2026-10', usd: 0.5, capUsd: 50 })
  })

  it('records nothing on a box that is not managed', () => {
    const plain = store(null)
    recordManagedSpend(1, { storeDir: plain, now: OCT })
    expect(readAiUsage(plain)).toBeNull()
  })
})

describe('usageWarningDue', () => {
  it('is null below 80%, the heads-up at 80%, then null once marked', () => {
    const d = store()
    recordManagedSpend(39.99, { storeDir: d, now: OCT })
    expect(usageWarningDue(d, OCT)).toBeNull()
    recordManagedSpend(0.01, { storeDir: d, now: OCT })
    expect(usageWarningDue(d, OCT)).toBe(usageWarningText(OCT))
    markUsageWarned(d, OCT)
    expect(usageWarningDue(d, OCT)).toBeNull()
    expect(JSON.parse(readFileSync(join(d, AI_USAGE_FILE), 'utf8')).warnedAt).toBe(OCT.toISOString())
  })

  it('a new cap re-arms the heads-up; none at or past the cap', () => {
    const d = store()
    recordManagedSpend(42, { storeDir: d, now: OCT })
    markUsageWarned(d, OCT)
    expect(usageWarningDue(d, OCT)).toBeNull()
    writeFileSync(join(d, MANAGED_AI_FILE), JSON.stringify({ since: '2026-10-01T00:00:00.000Z', capUsd: 52 }))
    expect(usageWarningDue(d, OCT)).toBe(usageWarningText(OCT))
    writeFileSync(join(d, MANAGED_AI_FILE), JSON.stringify({ since: '2026-10-01T00:00:00.000Z', capUsd: 40 }))
    expect(usageWarningDue(d, OCT)).toBeNull()
  })

  it('names the next renewal day in plain words', () => {
    expect(usageWarningText(OCT)).toContain('renews on November 1')
    expect(usageWarningText(new Date('2026-12-31T23:59:00Z'))).toContain('renews on January 1')
    expect(nextUtcMonthStart(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('is null with no cap recorded, or when the stored month is over', () => {
    const noCap = store({ since: '2026-10-01T00:00:00.000Z' })
    recordManagedSpend(1000, { storeDir: noCap, now: OCT })
    expect(usageWarningDue(noCap, OCT)).toBeNull()

    const d = store()
    recordManagedSpend(45, { storeDir: d, now: OCT })
    expect(usageWarningDue(d, new Date('2026-11-01T00:00:01Z'))).toBeNull()
  })
})

describe('pause replies name the renewal day', () => {
  const now = new Date('2026-10-24T15:00:00Z')

  it('uses the date from the limit error when the marker has one', () => {
    const first = ownerPauseReply({ kind: 'spend_limit', since: now.toISOString(), resumesAt: '2026-11-01T00:00:00.000Z' }, now)
    expect(first?.text).toBe(
      "I've reached this month's AI allowance, so I'm paused until November 1, or sooner if your provider raises it. Your provider has been told and will be in touch."
    )
    const later = new Date(now.getTime() + 25 * 3600_000)
    const repeat = ownerPauseReply(first!.next, later)
    expect(repeat?.text).toBe("Still paused: this month's AI allowance is used up until November 1. Your provider has been told.")
  })

  it('falls back to the undated copy without a date', () => {
    const first = ownerPauseReply({ kind: 'billing', since: now.toISOString() }, now)
    expect(first?.text).toBe(FIRST_REPLY)
    expect(ownerPauseReply(first!.next, new Date(now.getTime() + 25 * 3600_000))?.text).toBe(REPEAT_REPLY)
  })
})
