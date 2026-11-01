import { describe, it, expect } from 'vitest'
import type { UpcomingEvent } from '../src/proactive/calendar.js'
import { parseGoogleEvents, parseOutlookEvents } from '../src/proactive/calendar.js'
import {
  at,
  decisionKey,
  describeBackToBack,
  describeMoved,
  describeOverlap,
  findBackToBacks,
  findMoved,
  findOverlaps,
  formatTiming,
  noGapBetweenAddresses,
} from '../src/proactive/timing.js'

const TZ = 'America/Toronto'
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-10-30T13:00:00Z') // Fri 09:00 Toronto
const T = (h: number, m = 0) => Date.parse('2026-10-30T00:00:00Z') + 4 * HOUR + h * HOUR + m * MIN // h:m Toronto, Oct 30

function ev(id: string, start: number, end: number, over: Partial<UpcomingEvent> = {}): UpcomingEvent {
  return {
    account: 'me@x.com',
    provider: 'google',
    id,
    seriesKey: id,
    title: id.toUpperCase(),
    startMs: start,
    endMs: end,
    location: '',
    attendees: [],
    organizer: false,
    link: '',
    ...over,
  }
}

const words = { tz: TZ, nowMs: NOW, mode: 'drive' as const, format: 'plain' as const }

describe('overlaps', () => {
  it('finds meetings that run into each other, not ones that only touch', () => {
    const list = [ev('a', T(10), T(11)), ev('b', T(10, 30), T(11, 30)), ev('d', T(11), T(13)), ev('c', T(11, 30), T(12))]
    expect(findOverlaps(list, NOW, NOW + 24 * HOUR).map((o) => `${o.a.id}${o.b.id}`)).toEqual(['ab', 'bd', 'dc'])
  })

  it('skips free time and pairs that are already under way together', () => {
    const list = [ev('a', T(8), T(10)), ev('b', T(8, 30), T(9, 30)), ev('c', T(9, 30), T(10, 30), { free: true }), ev('d', T(9, 45), T(10, 15))]
    expect(findOverlaps(list, NOW, NOW + 24 * HOUR).map((o) => `${o.a.id}${o.b.id}`)).toEqual(['ad'])
  })

  it('stops at the end of the window', () => {
    const list = [ev('a', T(20), T(22)), ev('b', T(21), T(23))]
    expect(findOverlaps(list, NOW, T(19))).toEqual([])
  })

  it('reads the same way whichever meeting moved, and changes its signature', () => {
    const one = describeOverlap({ kind: 'overlap', a: ev('a', T(10), T(11)), b: ev('b', T(10, 30), T(11)) }, words)
    const two = describeOverlap({ kind: 'overlap', a: ev('b', T(9, 30), T(10, 30)), b: ev('a', T(10), T(11)) }, words)
    expect(one.key).toBe(two.key)
    expect(decisionKey(one)).not.toBe(decisionKey(two))
    expect(decisionKey(one, true)).toBe(`${decisionKey(one)}@soon`)
    expect(one.text).toBe('A (10:00 to 11:00) overlaps B (10:30 to 11:00).')
    expect(one.bitesMs).toBe(T(10, 30))
  })
})

describe('back-to-back meetings', () => {
  const A = '100 King St W, Toronto'
  const B = '1 Yonge St, Toronto'

  it('pairs an in-person meeting with the one just before it at another place', () => {
    const list = [ev('a', T(10), T(11), { location: A }), ev('b', T(11), T(12), { location: B }), ev('c', T(12), T(13), { location: B }), ev('d', T(13), T(14), { location: 'Zoom' })]
    const found = findBackToBacks(list, NOW, NOW + 24 * HOUR, false)
    expect(found.map((p) => `${p.a.id}${p.b.id}:${p.gapMinutes}`)).toEqual(['ab:0'])
    expect(noGapBetweenAddresses(found[0]!)).toBe(true)
    expect(noGapBetweenAddresses({ ...found[0]!, gapMinutes: 10 })).toBe(false)
  })

  it('only counts business names when maps can look them up', () => {
    const list = [ev('a', T(10), T(11), { location: 'Balzac Coffee' }), ev('b', T(11, 15), T(12), { location: B })]
    expect(findBackToBacks(list, NOW, NOW + 24 * HOUR, false)).toEqual([])
    const withMaps = findBackToBacks(list, NOW, NOW + 24 * HOUR, true)
    expect(withMaps).toHaveLength(1)
    expect(noGapBetweenAddresses(withMaps[0]!)).toBe(false)
  })

  it('says how long the trip takes against the gap, or that there is none', () => {
    const p = { kind: 'tight' as const, a: ev('a', T(10), T(11)), b: ev('b', T(11, 10), T(12)), from: A, to: B, gapMinutes: 10 }
    expect(describeBackToBack(p, 25, words).text).toBe(`A ends at 11:00 and B starts 10 min later, but the trip takes about 25 min by car.\nFrom ${A} to ${B}.`)
    expect(describeBackToBack({ ...p, gapMinutes: 0 }, null, { ...words, mode: 'walk' }).text).toContain('B starts with no gap, at a different address.')
    expect(describeBackToBack(p, 25, words)).toMatchObject({ usesMaps: true, bitesMs: T(11) })
  })
})

describe('moved meetings', () => {
  it('finds a time or place that differs from the last message, ignoring spacing and case', () => {
    const list = [ev('a', T(10), T(11), { location: '100 King St W' }), ev('b', T(12), T(13), { location: 'Room 4' }), ev('c', T(14), T(15))]
    const seen = (id: string) =>
      ({
        'google:me@x.com:a': { startMs: T(9), location: '100 King St W' },
        'google:me@x.com:b': { startMs: T(12), location: 'room  4' },
      })[id] ?? null
    expect(findMoved(list, NOW, NOW + 24 * HOUR, seen).map((m) => m.e.id)).toEqual(['a'])
  })

  it('says what changed', () => {
    const e = ev('a', T(15), T(16), { location: '1 Yonge St' })
    expect(describeMoved({ kind: 'moved', e, was: { startMs: T(14), location: '1 Yonge St' } }, words).text).toBe('A moved to 15:00 (was 14:00).')
    expect(describeMoved({ kind: 'moved', e, was: { startMs: T(15), location: 'Room 4' } }, words).text).toBe('A at 15:00 is now at 1 Yonge St (was Room 4).')
    expect(describeMoved({ kind: 'moved', e, was: { startMs: T(14), location: '' } }, words).text).toBe('A moved to 15:00 at 1 Yonge St (was 14:00 at no place set).')
    expect(describeMoved({ kind: 'moved', e: { ...e, location: '' }, was: { startMs: T(15), location: 'Room 4' } }, words).text).toBe('A at 15:00 no longer has a place set (was Room 4).')
  })
})

describe('words', () => {
  it('names the day only when it is not today', () => {
    expect(at(T(15), words)).toBe('15:00')
    expect(at(T(15) + 24 * HOUR, words)).toBe('tomorrow 15:00')
    expect(at(T(15) + 3 * 24 * HOUR, words)).toBe('Mon 14:00') // clocks went back on Nov 1
  })

  it('escapes markdown in titles and places', () => {
    const f = describeOverlap({ kind: 'overlap', a: ev('a', T(10), T(11), { title: 'Q4 [draft]' }), b: ev('b', T(10, 30), T(11)) }, { ...words, format: 'markdown' })
    expect(f.text).toContain('Q4 \\[draft\\]')
  })

  it('lists several problems as bullets, and credits the maps source when asked', () => {
    expect(formatTiming(['One.'], null)).toBe('Calendar check: One.')
    expect(formatTiming(['One.', 'Two.\nFrom here to there.'], 'Travel data from Google Maps')).toBe(
      'Calendar check:\n- One.\n- Two.\n  From here to there.\n\nTravel data from Google Maps'
    )
  })
})

describe('free time from the calendars', () => {
  it('reads Google transparency and Outlook show-as', () => {
    const g = parseGoogleEvents(
      JSON.stringify([
        { id: 'g1', summary: 'Hold', transparency: 'transparent', start: { dateTime: '2026-10-30T14:00:00Z' }, end: { dateTime: '2026-10-30T15:00:00Z' } },
        { id: 'g2', summary: 'Busy', start: { dateTime: '2026-10-30T14:00:00Z' }, end: { dateTime: '2026-10-30T15:00:00Z' } },
      ]),
      'me@x.com'
    )
    expect(g.map((e) => e.free ?? false)).toEqual([true, false])
    const o = parseOutlookEvents(
      [
        { id: 'o1', subject: 'Hold', showAs: 'free', start: { dateTime: '2026-10-30T14:00:00' }, end: { dateTime: '2026-10-30T15:00:00' } },
        { id: 'o2', subject: 'Busy', showAs: 'busy', start: { dateTime: '2026-10-30T14:00:00' }, end: { dateTime: '2026-10-30T15:00:00' } },
      ],
      'me@x.com',
      'me@x.com'
    )
    expect(o.map((e) => e.free ?? false)).toEqual([true, false])
  })
})
