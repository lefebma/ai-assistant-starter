import { describe, it, expect } from 'vitest'
import { isDay, nextDay, localDay, offsetMinutes, localMidnight, utcToLocal } from '../src/ms/time.js'

describe('isDay', () => {
  it('accepts a real date and rejects the rest', () => {
    expect(isDay('2026-09-20')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-9-20')).toBe(false)
    expect(isDay('today')).toBe(false)
  })
})

describe('nextDay', () => {
  it('rolls over months and years', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })
})

describe('localDay', () => {
  it('is the date where the owner is, not UTC', () => {
    expect(localDay(new Date('2026-09-16T03:30:00Z'), 'America/Toronto')).toBe('2026-09-15')
    expect(localDay(new Date('2026-09-16T03:30:00Z'), 'UTC')).toBe('2026-09-16')
  })
})

describe('offsetMinutes', () => {
  it('follows daylight saving', () => {
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Toronto')).toBe(-240)
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/Toronto')).toBe(-300)
  })

  it('handles zero and half-hour zones', () => {
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'UTC')).toBe(0)
    expect(offsetMinutes(new Date('2026-07-01T12:00:00Z'), 'Asia/Kolkata')).toBe(330)
  })
})

describe('localMidnight', () => {
  it('carries the offset that applies at that midnight', () => {
    expect(localMidnight('2026-09-16', 'America/Toronto')).toBe('2026-09-16T00:00:00-04:00')
    expect(localMidnight('2026-12-16', 'America/Toronto')).toBe('2026-12-16T00:00:00-05:00')
    expect(localMidnight('2026-09-16', 'Asia/Kolkata')).toBe('2026-09-16T00:00:00+05:30')
  })

  it('gets the day after a DST change right, not the offset from before it', () => {
    // Clocks go back at 2am on 2026-11-01 in Toronto; that day's midnight is
    // still daylight time, the next day's is standard.
    expect(localMidnight('2026-11-01', 'America/Toronto')).toBe('2026-11-01T00:00:00-04:00')
    expect(localMidnight('2026-11-02', 'America/Toronto')).toBe('2026-11-02T00:00:00-05:00')
    expect(localMidnight('2026-03-09', 'America/Toronto')).toBe('2026-03-09T00:00:00-04:00')
  })
})

describe('utcToLocal', () => {
  it('reads both stamp shapes Graph returns', () => {
    expect(utcToLocal('2026-09-16T13:00:00Z', 'America/Toronto')).toBe('2026-09-16T09:00:00')
    expect(utcToLocal('2026-09-16T13:00:00.0000000', 'America/Toronto')).toBe('2026-09-16T09:00:00')
  })

  it('crosses midnight when the zone does', () => {
    expect(utcToLocal('2026-09-16T02:00:00Z', 'America/Toronto')).toBe('2026-09-15T22:00:00')
  })

  it('passes through what it cannot parse instead of printing Invalid Date', () => {
    expect(utcToLocal('garbage', 'UTC')).toBe('garbage')
    expect(utcToLocal('', 'UTC')).toBe('')
  })
})
