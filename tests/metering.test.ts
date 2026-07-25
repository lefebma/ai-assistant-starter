import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { UsageMeter, recordUsage } from '../src/metering.js'

const NOW = 1_753_500_000 // fixed epoch seconds

function meter(): UsageMeter {
  return new UsageMeter(new Database(':memory:'))
}

describe('UsageMeter', () => {
  it('records runs and sums them per day/provider/model', () => {
    const m = meter()
    m.record({ ts: NOW, runtime: 'ai-sdk', provider: 'anthropic', model: 'claude-sonnet-5', sessionId: 's1', inputTokens: 100, outputTokens: 20, totalTokens: 120 })
    m.record({ ts: NOW + 60, runtime: 'ai-sdk', provider: 'anthropic', model: 'claude-sonnet-5', sessionId: 's1', inputTokens: 50, outputTokens: 10, totalTokens: 60 })
    const rows = m.summary()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      runs: 2,
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    })
  })

  it('groups by provider and model', () => {
    const m = meter()
    m.record({ ts: NOW, runtime: 'ai-sdk', provider: 'anthropic', model: 'claude-sonnet-5', totalTokens: 10 })
    m.record({ ts: NOW, runtime: 'ai-sdk', provider: 'openai', model: 'gpt-5.4', totalTokens: 20 })
    expect(m.summary()).toHaveLength(2)
  })

  it('treats missing token counts as zero', () => {
    const m = meter()
    m.record({ ts: NOW, runtime: 'ai-sdk', provider: 'google', model: 'gemini-2.5-pro' })
    const rows = m.summary()
    expect(rows[0].inputTokens).toBe(0)
    expect(rows[0].totalTokens).toBe(0)
    expect(rows[0].runs).toBe(1)
  })

  it('filters by sinceSecs', () => {
    const m = meter()
    m.record({ ts: NOW - 10 * 86400, runtime: 'ai-sdk', provider: 'anthropic', model: 'old', totalTokens: 5 })
    m.record({ ts: NOW, runtime: 'ai-sdk', provider: 'anthropic', model: 'new', totalTokens: 5 })
    const rows = m.summary({ sinceSecs: NOW - 86400 })
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe('new')
  })
})

describe('recordUsage', () => {
  it('never throws, even when the store is broken (metering must not break a turn)', () => {
    const broken = new UsageMeter({ exec: () => { throw new Error('disk full') } } as never)
    expect(recordUsage({ ts: NOW, runtime: 'ai-sdk', provider: 'x', model: 'y' }, broken)).toBe(false)
  })

  it('returns true on success', () => {
    expect(recordUsage({ ts: NOW, runtime: 'ai-sdk', provider: 'x', model: 'y' }, meter())).toBe(true)
  })
})
