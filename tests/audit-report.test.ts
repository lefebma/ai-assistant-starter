import { describe, it, expect } from 'vitest'
import { renderDigest, buildAuditPrompt, DIGEST_HEADING } from '../src/audit/report.js'
import type { AuditDigest } from '../src/audit/digest.js'

function digest(overrides: Partial<AuditDigest> = {}): AuditDigest {
  return {
    windowDays: 30,
    generatedAt: '2026-09-09T14:00:00.000Z',
    timeZone: 'America/Toronto',
    recordedTurns: 4,
    activeDays: 3,
    perDay: [
      { day: '2026-08-31', turns: 2 },
      { day: '2026-09-02', turns: 1 },
      { day: '2026-09-09', turns: 1 },
    ],
    byHour: [{ hour: 8, turns: 3 }, { hour: 21, turns: 1 }],
    byWeekday: [
      { weekday: 'Mon', turns: 2 },
      { weekday: 'Tue', turns: 1 },
      { weekday: 'Wed', turns: 1 },
      { weekday: 'Thu', turns: 0 },
      { weekday: 'Fri', turns: 0 },
      { weekday: 'Sat', turns: 0 },
      { weekday: 'Sun', turns: 0 },
    ],
    longestQuietRunDays: 6,
    firstTurn: '2026-08-31T12:00:00.000Z',
    lastTurn: '2026-09-09T12:00:00.000Z',
    samples: ['what does my calendar look like today', 'draft a reply to that client email'],
    samplesTruncated: false,
    skillsUsed: [{ id: 'gmail', name: 'Gmail', turns: 2 }],
    skillsUnused: [{ id: 'apollo', name: 'Apollo', turns: 0 }],
    tasks: [
      { name: 'Morning Briefing', schedule: '0 7 * * *', status: 'active', lastRun: 1757419200 },
      { name: 'Evening Debrief', schedule: '0 18 * * 1-5', status: 'paused', lastRun: null },
    ],
    tokens: { available: false, runs: 0, totalTokens: 0, models: [] },
    goals: { profileWritten: true, prioritiesRecorded: true },
    ...overrides,
  }
}

describe('renderDigest', () => {
  it('leads with the window and the timezone it was bucketed in', () => {
    const out = renderDigest(digest())
    expect(out.startsWith(DIGEST_HEADING)).toBe(true)
    expect(out).toContain('last 30 days')
    expect(out).toContain('America/Toronto')
  })

  it('reports turns against the days they landed on', () => {
    expect(renderDigest(digest())).toContain('4 recorded turns across 3 of 30 days')
  })

  it('names the skills that were never triggered', () => {
    const out = renderDigest(digest())
    expect(out).toContain('Never triggered')
    expect(out).toContain('Apollo')
  })

  it('says a task has never run rather than printing an epoch', () => {
    const out = renderDigest(digest())
    expect(out).toContain('never run')
    expect(out).not.toContain('null')
  })

  it('distinguishes token usage that is absent from token usage that is zero', () => {
    const out = renderDigest(digest())
    expect(out).toMatch(/not recorded on this install/i)
    expect(out).not.toMatch(/\b0 runs\b/)
  })

  it('reports token usage when the runtime records it', () => {
    const out = renderDigest(
      digest({ tokens: { available: true, runs: 12, totalTokens: 340_000, models: ['gpt-5.6'] } })
    )
    expect(out).toContain('12 runs')
    expect(out).toContain('gpt-5.6')
  })

  it('always carries the undercount caveat, so the model cannot read the count as a total', () => {
    const out = renderDigest(digest())
    expect(out).toMatch(/20 characters/)
    expect(out).toMatch(/slash commands/i)
    expect(out).toMatch(/floor/i)
  })

  it('says so plainly when nothing was recorded', () => {
    const out = renderDigest(
      digest({
        recordedTurns: 0,
        activeDays: 0,
        perDay: [],
        byHour: [],
        samples: [],
        firstTurn: null,
        lastTurn: null,
        longestQuietRunDays: 0,
      })
    )
    expect(out).toMatch(/no recorded turns/i)
  })

  it('wraps the day-by-day list instead of emitting one enormous line', () => {
    const perDay = Array.from({ length: 25 }, (_, i) => ({
      day: `2026-08-${String(i + 1).padStart(2, '0')}`,
      turns: i + 1,
    }))
    const out = renderDigest(digest({ perDay, activeDays: 25 }))
    const longest = Math.max(...out.split('\n').map((l) => l.length))
    expect(longest).toBeLessThan(100)
    expect(out).toContain('2026-08-25 (25)')
  })

  it('flags a truncated sample as a sample', () => {
    const out = renderDigest(digest({ recordedTurns: 400, samplesTruncated: true }))
    expect(out).toContain('2 of 400')
  })
})

describe('buildAuditPrompt', () => {
  it('carries the digest and forbids inventing numbers', () => {
    const prompt = buildAuditPrompt(digest())
    expect(prompt).toContain(DIGEST_HEADING)
    expect(prompt).toMatch(/do not invent/i)
  })

  it('asks for what is going unused, the part the owner cannot see', () => {
    expect(buildAuditPrompt(digest())).toMatch(/unused/i)
  })

  it('ties suggestions to recorded priorities when the profile has them', () => {
    const prompt = buildAuditPrompt(digest())
    expect(prompt).toMatch(/PROFILE\.md/)
    expect(prompt).toMatch(/priorities/i)
    expect(prompt).not.toMatch(/interview/i)
  })

  it('asks for goals when the profile records none', () => {
    const prompt = buildAuditPrompt(
      digest({ goals: { profileWritten: true, prioritiesRecorded: false } })
    )
    expect(prompt).toMatch(/no priorities recorded/i)
    expect(prompt).toMatch(/next 90 days/i)
  })

  it('offers the discovery interview when no profile was ever written', () => {
    const prompt = buildAuditPrompt(
      digest({ goals: { profileWritten: false, prioritiesRecorded: false } })
    )
    expect(prompt).toMatch(/interview/i)
  })

  it('forbids a usage report when there is no usage to report on', () => {
    const prompt = buildAuditPrompt(digest({ recordedTurns: 0, activeDays: 0, samples: [] }))
    expect(prompt).toMatch(/do not write a usage report/i)
  })

  it('warns against reading a trend into a thin month', () => {
    expect(buildAuditPrompt(digest())).toMatch(/thin/i)
  })
})

describe('profileHasPriorities', () => {
  it('finds a priorities section with content under it', async () => {
    const { profileHasPriorities } = await import('../src/audit/io.js')
    expect(
      profileHasPriorities('# About\n\n## Priorities, next 90 days\n\nClose three clients.\n')
    ).toBe(true)
  })

  it('treats an empty section as no priorities, which is the case that needs asking', async () => {
    const { profileHasPriorities } = await import('../src/audit/io.js')
    expect(profileHasPriorities('# About\n\n## Priorities\n\n## People\n\nAlice.\n')).toBe(false)
  })

  it('ignores a comment left in an otherwise empty section', async () => {
    const { profileHasPriorities } = await import('../src/audit/io.js')
    expect(profileHasPriorities('## Priorities\n<!-- fill this in -->\n')).toBe(false)
  })

  it('is false when the file has no priorities section at all', async () => {
    const { profileHasPriorities } = await import('../src/audit/io.js')
    expect(profileHasPriorities('# About\n\n## People\n\nAlice.\n')).toBe(false)
  })
})
