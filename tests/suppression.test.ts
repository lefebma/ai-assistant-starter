import { describe, it, expect } from 'vitest'
import { shouldSuppressResult } from '../src/suppression.js'

describe('silent-task suppression', () => {
  it('should suppress result when output contains HEARTBEAT_OK', () => {
    expect(shouldSuppressResult('HEARTBEAT_OK')).toBe(true)
  })

  it('should suppress result when output contains NO_REPLY', () => {
    expect(shouldSuppressResult('NO_REPLY')).toBe(true)
  })

  it('should suppress result when output contains NO_ACTION', () => {
    expect(shouldSuppressResult('NO_ACTION')).toBe(true)
  })

  it('should suppress result when output contains NOTHING_TO_REPORT', () => {
    expect(shouldSuppressResult('NOTHING_TO_REPORT')).toBe(true)
  })

  it('should not suppress result with actionable content', () => {
    expect(shouldSuppressResult('Here is your morning briefing: ...')).toBe(false)
  })

  it('suppresses a bare token with decoration around it', () => {
    for (const r of ['  NO_REPLY\n', '**NO_REPLY**', '`HEARTBEAT_OK`', '"NO_ACTION"', 'NOTHING_TO_REPORT.', '_NO_REPLY_']) {
      expect(shouldSuppressResult(r), r).toBe(true)
    }
  })

  it('does not suppress a real report that mentions a token or heartbeat words', () => {
    const reports = [
      'Reminder: wake the dojo list at 5. The heartbeat check said HEARTBEAT_OK earlier, nothing else.',
      'The NO_REPLY rule swallowed Tuesday\'s digest. Please check the scheduler.',
      'NO_REPLY was returned for 3 of 4 boards. Board 4 has a new card: Invoice 2210 overdue.',
      'Heartbeat OK, but Norwin replied and you owe him a call today.',
      'NOT_NO_REPLY',
      'no_reply',
    ]
    for (const r of reports) expect(shouldSuppressResult(r), r).toBe(false)
  })

  it('suppresses an explanation that ends with the token alone on the last line', () => {
    expect(shouldSuppressResult('No changes detected. All 4 cards are the same.\n\nNO_REPLY')).toBe(true)
    expect(shouldSuppressResult('Only an automated acknowledgement, nothing asked of you.\n\nHEARTBEAT_OK\n')).toBe(true)
  })

  it('does not suppress a report that has a token on an earlier line', () => {
    expect(shouldSuppressResult('NO_REPLY\nActually, Norwin wrote back: please call him today.')).toBe(false)
    expect(shouldSuppressResult('Board 1: NO_REPLY\nBoard 2: invoice 2210 is overdue.')).toBe(false)
  })

  it('does not suppress an empty result', () => {
    expect(shouldSuppressResult('')).toBe(false)
    expect(shouldSuppressResult('   ')).toBe(false)
  })
})
