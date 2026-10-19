import { describe, it, expect } from 'vitest'
import {
  senderAddress,
  matchesList,
  isAutomated,
  preDecide,
  pauseUntil,
  inQuietHours,
  nextQuietEnd,
  localDay,
} from '../src/email-alerts/rules.js'

const TZ = 'America/Toronto'
const at = (iso: string) => new Date(iso)

describe('senderAddress', () => {
  it('handles display names and bare addresses', () => {
    expect(senderAddress('Jane Doe <Jane@X.com>')).toBe('jane@x.com')
    expect(senderAddress('  Bob@Y.org ')).toBe('bob@y.org')
  })
})

describe('matchesList', () => {
  it('domain entry matches subdomain', () => {
    expect(matchesList('a@mail.acme.com', ['acme.com'])).toBe(true)
    expect(matchesList('a@acme.com', ['acme.com'])).toBe(true)
    expect(matchesList('a@notacme.com', ['acme.com'])).toBe(false)
  })
  it('address entry matches exactly', () => {
    expect(matchesList('a@acme.com', ['A@acme.com'])).toBe(true)
    expect(matchesList('b@acme.com', ['a@acme.com'])).toBe(false)
  })
})

describe('isAutomated', () => {
  it('by header', () => {
    expect(isAutomated({ from: 'Jane <jane@x.com>', listUnsubscribe: '<mailto:u@x>' })).toBe(true)
    expect(isAutomated({ from: 'jane@x.com', listId: 'l' })).toBe(true)
    expect(isAutomated({ from: 'jane@x.com', autoSubmitted: 'auto-generated' })).toBe(true)
    expect(isAutomated({ from: 'jane@x.com', autoSubmitted: 'no' })).toBe(false)
    expect(isAutomated({ from: 'jane@x.com', precedence: 'bulk' })).toBe(true)
    expect(isAutomated({ from: 'jane@x.com', precedence: 'normal' })).toBe(false)
  })
  it('by local part', () => {
    expect(isAutomated({ from: 'noreply@x.com' })).toBe(true)
    expect(isAutomated({ from: 'GitHub <notifications@github.com>' })).toBe(true)
    expect(isAutomated({ from: 'jane@x.com' })).toBe(false)
  })
})

describe('preDecide', () => {
  it('mute beats vip', () => {
    expect(preDecide({ from: 'a@x.com' }, ['a@x.com'], ['a@x.com'])).toBe('mute')
  })
  it('vip beats automated', () => {
    expect(preDecide({ from: 'a@vip.com', listUnsubscribe: '<u>' }, ['vip.com'], [])).toBe('vip')
  })
  it('automated and triage', () => {
    expect(preDecide({ from: 'noreply@x.com' }, [], [])).toBe('automated')
    expect(preDecide({ from: 'jane@x.com' }, [], [])).toBe('triage')
  })
})

describe('inQuietHours', () => {
  it('window wraps midnight', () => {
    // Toronto EDT (UTC-4) on 2026-10-18
    expect(inQuietHours(at('2026-10-19T03:30:00Z'), TZ, '22:00', '07:00')).toBe(true) // 23:30
    expect(inQuietHours(at('2026-10-19T10:59:00Z'), TZ, '22:00', '07:00')).toBe(true) // 06:59
    expect(inQuietHours(at('2026-10-19T11:00:00Z'), TZ, '22:00', '07:00')).toBe(false) // 07:00
    expect(inQuietHours(at('2026-10-19T01:59:00Z'), TZ, '22:00', '07:00')).toBe(false) // 21:59
  })
  it('same-day window', () => {
    expect(inQuietHours(at('2026-10-18T17:00:00Z'), TZ, '12:00', '14:00')).toBe(true)
    expect(inQuietHours(at('2026-10-18T19:00:00Z'), TZ, '12:00', '14:00')).toBe(false)
  })
})

describe('pauseUntil', () => {
  const now = at('2026-10-18T15:00:00Z')
  it('1h, 1d, 1w, off', () => {
    expect(pauseUntil('1h', now, TZ, '07:00')).toBe(now.getTime() + 3_600_000)
    expect(pauseUntil('1d', now, TZ, '07:00')).toBe(now.getTime() + 86_400_000)
    expect(pauseUntil('1w', now, TZ, '07:00')).toBe(now.getTime() + 604_800_000)
    expect(pauseUntil('off', now, TZ, '07:00')).toBeNull()
  })
  it('tomorrow uses the box timezone across DST', () => {
    // 2026-11-01 01:30 EDT = 05:30Z, DST ends 02:00 that day
    expect(pauseUntil('tomorrow', at('2026-11-01T05:30:00Z'), TZ, '07:00')).toBe(Date.parse('2026-11-01T12:00:00Z'))
    // 2026-11-01 08:00 EST = 13:00Z
    expect(pauseUntil('tomorrow', at('2026-11-01T13:00:00Z'), TZ, '07:00')).toBe(Date.parse('2026-11-02T12:00:00Z'))
  })
  it('nextQuietEnd is strictly after now', () => {
    expect(nextQuietEnd(at('2026-10-19T11:00:00Z'), TZ, '07:00')).toBe(Date.parse('2026-10-20T11:00:00Z'))
  })
})

describe('localDay', () => {
  it('rolls at local midnight, not UTC', () => {
    expect(localDay(at('2026-10-19T03:59:00Z'), TZ)).toBe('2026-10-18')
    expect(localDay(at('2026-10-19T04:00:00Z'), TZ)).toBe('2026-10-19')
  })
})
