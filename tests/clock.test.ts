import { describe, it, expect } from 'vitest'
import { clockLine } from '../src/clock.js'

describe('clockLine', () => {
  it('names the weekday, date, time and zone, and tomorrow', () => {
    // 2026-11-16 was a Monday; a model left to work it out said Sunday.
    const line = clockLine(new Date('2026-11-16T18:24:00Z'), 'America/New_York')
    expect(line).toContain('Monday, November 16, 2026')
    expect(line).toContain('1:24 PM')
    expect(line).toContain('America/New_York')
    expect(line).toContain('Tomorrow is Tuesday, November 17')
  })

  it('uses the install zone, not UTC, near midnight', () => {
    // 03:00 UTC on the 17th is still the evening of the 16th in New York.
    const line = clockLine(new Date('2026-11-17T03:00:00Z'), 'America/New_York')
    expect(line).toContain('Monday, November 16, 2026')
    expect(line).toContain('10:00 PM')
    expect(line).toContain('Tomorrow is Tuesday, November 17')
  })

  it('rolls tomorrow over a month and a year end', () => {
    expect(clockLine(new Date('2026-12-31T17:00:00Z'), 'Europe/London')).toContain('Tomorrow is Friday, January 1, 2027')
  })
})
