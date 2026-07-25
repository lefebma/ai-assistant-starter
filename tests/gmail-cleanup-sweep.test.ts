import { describe, it, expect, vi } from 'vitest'
import { runSweep } from '../src/gmail-cleanup/sweep.js'
import type { SweepIO } from '../src/gmail-cleanup/sweep.js'

function hexId(n: number): string {
  return n.toString(16).padStart(16, '0')
}

function row(id: string, date = '2020-01-01 00:00', labels = 'CATEGORY_PROMOTIONS'): string {
  return `${id}\t${date}\tfrom@x.com\tSubject\t${labels}\t${id}`
}

function page(rows: string[], token?: string): string {
  const lines = ['# Query: whatever', ...rows]
  if (token) lines.push(`# Next page: --page ${token}`)
  return lines.join('\n')
}

const STEP = { query: 'category:promotions older_than:3m', cutoff: '2026-04-25', requiredLabel: 'CATEGORY_PROMOTIONS' }
const noSleep = async () => {}

function fakeIO(pages: Array<{ ok: boolean; output: string }>, trashOk = true) {
  const search = vi.fn(async () => pages[Math.min(search.mock.calls.length - 1, pages.length - 1)])
  const trash = vi.fn(async () => trashOk)
  const io: SweepIO = { search, trash, sleep: noSleep }
  return { io, search, trash }
}

describe('runSweep', () => {
  it('clean run: no rows, nothing trashed, trash never called', async () => {
    const { io, trash } = fakeIO([{ ok: true, output: page([]) }])
    const result = await runSweep(STEP, io)
    expect(result).toEqual({ trashed: 0, skipped: 0, errors: [] })
    expect(trash).not.toHaveBeenCalled()
  })

  it('trashes filtered rows in chunks of 25', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(hexId(i)))
    const { io, trash } = fakeIO([{ ok: true, output: page(rows) }])
    const result = await runSweep(STEP, io)
    expect(result.trashed).toBe(60)
    expect(trash).toHaveBeenCalledTimes(3)
    expect(trash.mock.calls.map((c) => (c as string[][])[0].length)).toEqual([25, 25, 10])
  })

  it('counts protected rows as skipped, not trashed', async () => {
    const rows = [
      row(hexId(1)),
      row(hexId(2), '2020-01-01 00:00', 'CATEGORY_PROMOTIONS,STARRED'),
      row(hexId(3), '2026-07-01 00:00'),
    ]
    const { io } = fakeIO([{ ok: true, output: page(rows) }])
    const result = await runSweep(STEP, io)
    expect(result.trashed).toBe(1)
    expect(result.skipped).toBe(2)
  })

  it('does not re-trash ids that reappear from Gmail index lag', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => hexId(i))
    const rows = ids.map((id) => row(id))
    const { io, trash } = fakeIO([
      { ok: true, output: page(rows, 't1') },
      { ok: true, output: page(rows, 't2') }, // same ids reappear
      { ok: true, output: page([]) },
    ])
    const result = await runSweep(STEP, io, { perPage: 5 })
    expect(result.trashed).toBe(5)
    expect(trash).toHaveBeenCalledTimes(1)
  })

  it('keeps paginating when a page is fully protected but has a next page', async () => {
    const starred = Array.from({ length: 3 }, (_, i) => row(hexId(i), '2020-01-01 00:00', 'STARRED'))
    const { io } = fakeIO([
      { ok: true, output: page(starred, 't1') },
      { ok: true, output: page([row(hexId(9))]) },
    ])
    const result = await runSweep(STEP, io, { perPage: 3 })
    expect(result.trashed).toBe(1)
    expect(result.skipped).toBe(3)
  })

  it('stops when a page is fully protected and there is no next page', async () => {
    const starred = [row(hexId(1), '2020-01-01 00:00', 'STARRED')]
    const { io, search } = fakeIO([{ ok: true, output: page(starred) }])
    const result = await runSweep(STEP, io)
    expect(result.trashed).toBe(0)
    expect(result.skipped).toBe(1)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('records a search failure and stops', async () => {
    const { io, trash } = fakeIO([{ ok: false, output: 'gog exploded' }])
    const result = await runSweep(STEP, io)
    expect(result.errors[0]).toMatch(/search failed/)
    expect(result.errors[0]).toContain('gog exploded')
    expect(trash).not.toHaveBeenCalled()
  })

  it('records a trash failure and stops', async () => {
    const rows = [row(hexId(1)), row(hexId(2))]
    const { io } = fakeIO([{ ok: true, output: page(rows) }], false)
    const result = await runSweep(STEP, io)
    expect(result.errors[0]).toMatch(/batch modify failed/)
    expect(result.trashed).toBe(0)
  })

  it('dry run counts the first page only and never trashes', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => row(hexId(i)))
    const { io, trash, search } = fakeIO([
      { ok: true, output: page(rows, 't1') },
      { ok: true, output: page([row(hexId(9))]) },
    ])
    const result = await runSweep(STEP, io, { perPage: 4, dryRun: true })
    expect(result.trashed).toBe(4)
    expect(trash).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('maxIter caps the number of pages fetched', async () => {
    // Every page returns perPage fresh ids and a token: would loop forever without the cap.
    let counter = 0
    const search = vi.fn(async () => {
      const rows = Array.from({ length: 2 }, () => row(hexId(counter++)))
      return { ok: true, output: page(rows, `t${counter}`) }
    })
    const trash = vi.fn(async () => true)
    const result = await runSweep(STEP, { search, trash, sleep: noSleep }, { perPage: 2, maxIter: 3 })
    expect(search).toHaveBeenCalledTimes(3)
    expect(result.trashed).toBe(6)
  })
})
