import { describe, it, expect } from 'vitest'
import {
  parseSearchPage,
  filterRows,
  cutoffDate,
  oneShotCron,
  buildReport,
  chunk,
} from '../src/gmail-cleanup/core.js'

const TSV = [
  '# Query: category:promotions older_than:3m',
  'ID\tDATE\tFROM\tSUBJECT\tLABELS\tTHREAD',
  'aaaa111122223333\t2025-01-15 10:30\ta@x.com\tBig Sale\tCATEGORY_PROMOTIONS,UNREAD\taaaa111122223333',
  'bbbb111122223333\t2025-02-01 09:00\tb@x.com\tStarred deal\tCATEGORY_PROMOTIONS,STARRED\tbbbb111122223333',
  'cccc111122223333\t2025-03-10 08:00\tc@x.com\tAlready gone\tCATEGORY_PROMOTIONS,TRASH\tcccc111122223333',
  'dddd111122223333\t2026-07-01 12:00\td@x.com\tToo recent\tCATEGORY_PROMOTIONS\tdddd111122223333',
  'eeee111122223333\t2025-04-20 11:00\te@x.com\tPersonal sibling\tINBOX\teeee111122223333',
  'not-a-message-id\t2025-01-01 00:00\tx@x.com\tjunk\tINBOX\tzzzz',
  '# Next page: --page TOKEN123',
].join('\n')

describe('parseSearchPage', () => {
  it('extracts data rows by 16-hex id and the next-page token', () => {
    const page = parseSearchPage(TSV)
    expect(page.rows.map((r) => r.id)).toEqual([
      'aaaa111122223333',
      'bbbb111122223333',
      'cccc111122223333',
      'dddd111122223333',
      'eeee111122223333',
    ])
    expect(page.rows[0]).toEqual({
      id: 'aaaa111122223333',
      date: '2025-01-15 10:30',
      labels: 'CATEGORY_PROMOTIONS,UNREAD',
    })
    expect(page.nextPageToken).toBe('TOKEN123')
  })

  it('returns null token when there is no next page', () => {
    const page = parseSearchPage('aaaa111122223333\t2025-01-15 10:30\ta@x.com\tS\tINBOX\tt')
    expect(page.nextPageToken).toBeNull()
  })
})

describe('filterRows', () => {
  const rows = parseSearchPage(TSV).rows

  it('keeps only rows older than cutoff, unstarred, untrashed, with the required label', () => {
    const keep = filterRows(rows, {
      cutoff: '2026-04-25',
      requiredLabel: 'CATEGORY_PROMOTIONS',
      exclude: new Set(),
    })
    expect(keep).toEqual(['aaaa111122223333'])
  })

  it('without a required label, keeps any unprotected row older than cutoff', () => {
    const keep = filterRows(rows, { cutoff: '2026-04-25', exclude: new Set() })
    expect(keep).toEqual(['aaaa111122223333', 'eeee111122223333'])
  })

  it('drops ids already trashed this run (Gmail index lag)', () => {
    const keep = filterRows(rows, {
      cutoff: '2026-04-25',
      exclude: new Set(['aaaa111122223333']),
    })
    expect(keep).toEqual(['eeee111122223333'])
  })
})

describe('cutoffDate', () => {
  it('subtracts months', () => {
    expect(cutoffDate(new Date(2026, 6, 25), { months: 3 })).toBe('2026-04-25')
  })

  it('clamps to the last day of the target month', () => {
    expect(cutoffDate(new Date(2026, 4, 31), { months: 3 })).toBe('2026-02-28')
    expect(cutoffDate(new Date(2024, 4, 31), { months: 3 })).toBe('2024-02-29')
  })

  it('subtracts years', () => {
    expect(cutoffDate(new Date(2026, 6, 25), { years: 5 })).toBe('2021-07-25')
  })
})

describe('oneShotCron', () => {
  it('builds a cron for now + offset minutes without leading zeros', () => {
    expect(oneShotCron(new Date(2026, 6, 25, 14, 9), 2)).toBe('11 14 25 7 *')
  })

  it('rolls over midnight correctly', () => {
    expect(oneShotCron(new Date(2026, 6, 25, 23, 59), 2)).toBe('1 0 26 7 *')
  })
})

describe('buildReport', () => {
  it('returns null on a clean run with nothing trashed', () => {
    expect(buildReport({ promoTrashed: 0, ancientTrashed: 0, skipped: 12, errors: [] })).toBeNull()
  })

  it('reports counts when something was trashed', () => {
    const report = buildReport({ promoTrashed: 40, ancientTrashed: 3, skipped: 7, errors: [] })
    expect(report).toContain('40 promo')
    expect(report).toContain('3 ancient')
    expect(report).toContain('7 protected')
  })

  it('includes errors even when nothing was trashed', () => {
    const report = buildReport({ promoTrashed: 0, ancientTrashed: 0, skipped: 0, errors: ['search failed'] })
    expect(report).toContain('search failed')
  })
})

describe('chunk', () => {
  it('splits into fixed-size chunks with a remainder', () => {
    expect(chunk(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })
})
