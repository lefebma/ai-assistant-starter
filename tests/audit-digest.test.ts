import { describe, it, expect } from 'vitest'
import {
  collectAudit,
  localStamp,
  longestQuietRun,
  sampleTurns,
  parseTurnContent,
  scrubPaths,
  isRequestTurn,
  MEMORY_TURN_PREFIX,
  type AuditIO,
  type AuditTurn,
} from '../src/audit/digest.js'

const TZ = 'America/Toronto'

/** Epoch seconds for an ISO instant, so tests read as wall clock. */
function at(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000)
}

function turn(iso: string, text: string): AuditTurn {
  return { at: at(iso), text }
}

function fakeIO(overrides: Partial<AuditIO> = {}): AuditIO {
  return {
    turns: () => [],
    tasks: () => [],
    enabledSkills: () => [],
    matchTurn: () => [],
    tokenUsage: () => ({ available: false, runs: 0, totalTokens: 0, models: [] }),
    goals: () => ({ profileWritten: false, prioritiesRecorded: false }),
    now: () => at('2026-09-09T14:00:00Z'),
    timeZone: () => TZ,
    ...overrides,
  }
}

describe('localStamp', () => {
  it('buckets by the install timezone, not UTC', () => {
    // 02:30 UTC on Tue Sep 1 is 22:30 EDT on Mon Aug 31.
    expect(localStamp(at('2026-09-01T02:30:00Z'), TZ)).toEqual({
      day: '2026-08-31',
      hour: 22,
      weekday: 'Mon',
    })
  })

  it('reports midnight as hour 0, never 24', () => {
    expect(localStamp(at('2026-09-01T04:10:00Z'), TZ).hour).toBe(0)
  })

  it('handles a zone ahead of UTC', () => {
    expect(localStamp(at('2026-09-01T23:30:00Z'), 'Australia/Sydney')).toEqual({
      day: '2026-09-02',
      hour: 9,
      weekday: 'Wed',
    })
  })
})

describe('parseTurnContent', () => {
  it('strips the memory row prefix', () => {
    expect(parseTurnContent(`${MEMORY_TURN_PREFIX}book me a flight`)).toBe('book me a flight')
  })

  it('leaves a row without the prefix alone', () => {
    expect(parseTurnContent('book me a flight')).toBe('book me a flight')
  })
})

describe('isRequestTurn', () => {
  it('drops a button click, which is a tap and not a request', () => {
    expect(isRequestTurn('[button_click]: Send')).toBe(false)
  })

  it('keeps a voice note, which is a request that happens to be spoken', () => {
    expect(isRequestTurn('[Voice message transcription]: what is on my calendar')).toBe(true)
  })

  it('keeps ordinary text', () => {
    expect(isRequestTurn('draft a reply to that email')).toBe(true)
  })
})

describe('scrubPaths', () => {
  it('strips a home directory path, which names the owner', () => {
    expect(scrubPaths('[Photo attached: /Users/jane/Projects/app/uploads/1.jpg]')).toBe(
      '[Photo attached: [path]]'
    )
  })

  it('strips linux and windows paths too', () => {
    expect(scrubPaths('saved to /home/deploy/store/x.db')).toBe('saved to [path]')
    expect(scrubPaths('open C:\\Users\\Sam\\notes.txt')).toBe('open [path]')
  })

  it('leaves a url alone', () => {
    expect(scrubPaths('read https://example.com/Users/docs/page')).toBe(
      'read https://example.com/Users/docs/page'
    )
  })

  it('leaves ordinary prose alone', () => {
    expect(scrubPaths('book the 9/10 flight and/or the train')).toBe(
      'book the 9/10 flight and/or the train'
    )
  })
})

describe('longestQuietRun', () => {
  it('counts whole days with nothing between two active days', () => {
    expect(longestQuietRun(['2026-09-01', '2026-09-05'], '2026-09-05')).toBe(3)
  })

  it('counts the trailing silence up to today', () => {
    expect(longestQuietRun(['2026-09-01'], '2026-09-04')).toBe(2)
  })

  it('is zero when every day since the first turn was active', () => {
    expect(longestQuietRun(['2026-09-01', '2026-09-02'], '2026-09-02')).toBe(0)
  })

  it('never counts silence before the first recorded turn', () => {
    // First turn is recent; the empty weeks before it are not the owner ignoring
    // the assistant, they are the assistant not existing yet.
    expect(longestQuietRun(['2026-09-08'], '2026-09-09')).toBe(0)
  })

  it('is zero with no active days at all', () => {
    expect(longestQuietRun([], '2026-09-09')).toBe(0)
  })
})

describe('sampleTurns', () => {
  const many: AuditTurn[] = Array.from({ length: 10 }, (_, i) =>
    turn('2026-09-01T12:00:00Z', `question ${i}`)
  )

  it('spreads the sample across the window instead of taking the oldest', () => {
    const { samples, truncated } = sampleTurns(many, 4, 200)
    expect(truncated).toBe(true)
    expect(samples).toEqual(['question 0', 'question 2', 'question 5', 'question 7'])
  })

  it('keeps everything when it fits', () => {
    const { samples, truncated } = sampleTurns(many.slice(0, 3), 4, 200)
    expect(truncated).toBe(false)
    expect(samples).toHaveLength(3)
  })

  it('clips long turns', () => {
    const { samples } = sampleTurns([turn('2026-09-01T12:00:00Z', 'x'.repeat(50))], 4, 10)
    expect(samples[0]).toBe(`${'x'.repeat(10)}...`)
  })

  it('redacts secrets that were pasted into a conversation', () => {
    const { samples } = sampleTurns(
      [turn('2026-09-01T12:00:00Z', 'set my key to sk-abcdefghijklmnop please')],
      4,
      200
    )
    expect(samples[0]).not.toContain('sk-abcdefghijklmnop')
    expect(samples[0]).toContain('[redacted]')
  })

  it('returns nothing for no turns', () => {
    expect(sampleTurns([], 4, 200)).toEqual({ samples: [], truncated: false })
  })
})

describe('collectAudit', () => {
  const turns: AuditTurn[] = [
    turn('2026-08-31T12:00:00Z', 'what does my calendar look like today'),
    turn('2026-08-31T13:00:00Z', 'draft a reply to that client email'),
    turn('2026-09-02T12:30:00Z', 'what is the weather in Toronto tomorrow'),
    turn('2026-09-09T12:00:00Z', 'summarise the board for me'),
  ]

  it('counts recorded turns and the days they landed on', () => {
    const d = collectAudit('chat-1', fakeIO({ turns: () => turns }))
    expect(d.recordedTurns).toBe(4)
    expect(d.activeDays).toBe(3)
    expect(d.windowDays).toBe(30)
    expect(d.perDay).toEqual([
      { day: '2026-08-31', turns: 2 },
      { day: '2026-09-02', turns: 1 },
      { day: '2026-09-09', turns: 1 },
    ])
  })

  it('reports every weekday including the ones with nothing on them', () => {
    const d = collectAudit('chat-1', fakeIO({ turns: () => turns }))
    expect(d.byWeekday.map((w) => w.weekday)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(d.byWeekday.find((w) => w.weekday === 'Sat')).toEqual({ weekday: 'Sat', turns: 0 })
    expect(d.byWeekday.find((w) => w.weekday === 'Mon')?.turns).toBe(2)
  })

  it('splits enabled skills into used and never triggered', () => {
    const d = collectAudit(
      'chat-1',
      fakeIO({
        turns: () => turns,
        enabledSkills: () => [
          { id: 'weather', name: 'Weather' },
          { id: 'gmail', name: 'Gmail' },
          { id: 'apollo', name: 'Apollo' },
        ],
        matchTurn: (text) => {
          const hits: string[] = []
          if (/weather/i.test(text)) hits.push('weather')
          if (/email/i.test(text)) hits.push('gmail')
          return hits
        },
      })
    )
    expect(d.skillsUsed).toEqual([
      { id: 'gmail', name: 'Gmail', turns: 1 },
      { id: 'weather', name: 'Weather', turns: 1 },
    ])
    expect(d.skillsUnused).toEqual([{ id: 'apollo', name: 'Apollo', turns: 0 }])
  })

  it('never reports a skill that is not enabled, even if a turn matched it', () => {
    const d = collectAudit(
      'chat-1',
      fakeIO({
        turns: () => turns,
        enabledSkills: () => [{ id: 'weather', name: 'Weather' }],
        matchTurn: () => ['weather', 'ghost'],
      })
    )
    expect(d.skillsUsed.map((s) => s.id)).toEqual(['weather'])
    expect(d.skillsUnused).toEqual([])
  })

  it('asks the store only for the window it reports on', () => {
    let asked: { chatId: string; since: number } | null = null
    const now = at('2026-09-09T14:00:00Z')
    collectAudit(
      'chat-7',
      fakeIO({
        now: () => now,
        turns: (chatId, since) => {
          asked = { chatId, since }
          return []
        },
      })
    )
    expect(asked).toEqual({ chatId: 'chat-7', since: now - 30 * 86400 })
  })

  it('honours a shorter window', () => {
    const d = collectAudit('chat-1', fakeIO({ turns: () => turns }), { windowDays: 7 })
    expect(d.windowDays).toBe(7)
  })

  it('survives an install with nothing recorded', () => {
    const d = collectAudit('chat-1', fakeIO())
    expect(d.recordedTurns).toBe(0)
    expect(d.activeDays).toBe(0)
    expect(d.longestQuietRunDays).toBe(0)
    expect(d.firstTurn).toBeNull()
    expect(d.samples).toEqual([])
  })

it('does not count button taps as turns', () => {
    const d = collectAudit(
      'chat-1',
      fakeIO({
        turns: () => [
          turn('2026-09-08T12:00:00Z', 'summarise the board for me'),
          turn('2026-09-08T12:01:00Z', '[button_click]: Send'),
        ],
      })
    )
    expect(d.recordedTurns).toBe(1)
    expect(d.samples).toEqual(['summarise the board for me'])
  })

  it('scrubs filesystem paths out of the sample', () => {
    const d = collectAudit(
      'chat-1',
      fakeIO({
        turns: () => [turn('2026-09-08T12:00:00Z', '[Photo attached: /Users/jane/uploads/1.jpg] what is this')],
      })
    )
    expect(d.samples[0]).not.toContain('/Users/jane')
    expect(d.samples[0]).toContain('[path]')
  })

  it('carries the goal state through untouched', () => {
    const d = collectAudit(
      'chat-1',
      fakeIO({ goals: () => ({ profileWritten: true, prioritiesRecorded: false }) })
    )
    expect(d.goals).toEqual({ profileWritten: true, prioritiesRecorded: false })
  })
})
