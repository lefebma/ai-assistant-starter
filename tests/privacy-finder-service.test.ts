/** The finder's queue, background worker and offer timer (card #275). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { quiet } = vi.hoisted(() => ({ quiet: { value: null as null | { start: string; end: string } } }))
vi.mock('../src/proactive/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/proactive/settings.js')>()),
  getQuietHours: () => quiet.value,
}))

process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'privacy-finder-svc-'))

let db: typeof import('../src/db.js')
let store: typeof import('../src/privacy/store.js')
let sug: typeof import('../src/privacy/finder/suggestions.js')
let svc: typeof import('../src/privacy/finder/service.js')

beforeAll(async () => {
  db = await import('../src/db.js')
  db.initDatabase()
  store = await import('../src/privacy/store.js')
  sug = await import('../src/privacy/finder/suggestions.js')
  svc = await import('../src/privacy/finder/service.js')
})

const DEVON = 'Remind me to call Devon Spencer at Southtel Communications Inc. tomorrow.'
const devonTags = [
  { entity: 'B-PER', word: 'Devon', score: 0.999, index: 6 },
  { entity: 'I-PER', word: 'Spencer', score: 0.998, index: 7 },
]

let stop: (() => void) | null = null
function deps(over: Partial<import('../src/privacy/finder/service.js').FinderDeps> = {}) {
  const sent: Array<{ text: string; buttons: string[] }> = []
  const d: import('../src/privacy/finder/service.js').FinderDeps = {
    tagger: { tag: vi.fn(async () => devonTags), disabled: () => false, unloadIfIdle: vi.fn() },
    send: vi.fn(async (text: string, buttons: string[]) => {
      sent.push({ text, buttons })
      return `main:${sent.length}`
    }),
    buttons: true,
    busy: () => false,
    now: () => new Date('2026-11-16T15:00:00Z'),
    tz: 'America/New_York',
    skip: () => new Set(),
    ...over,
  }
  return { d, sent }
}

beforeEach(() => {
  db.getDb().exec("DELETE FROM privacy_names; DELETE FROM privacy_suggestions; DELETE FROM app_state WHERE key LIKE 'privacy:%'")
  store.resetPrivacyCache()
  store.setChatPrivacy('main', true)
  quiet.value = null
  svc.clearFinderQueue()
})

afterEach(() => {
  stop?.()
  stop = null
})

describe('noteForFinder', () => {
  it('queues nothing while the filter is off, for commands, or from another chat', () => {
    stop = svc.startNameFinder(deps().d, { worker: false })
    svc.noteForFinder(true, '/private list')
    svc.noteForFinder(false, DEVON)
    store.setChatPrivacy('main', false)
    svc.noteForFinder(true, DEVON)
    expect(svc.finderQueueLength()).toBe(0)
  })

  it('queues nothing before the finder starts', () => {
    svc.noteForFinder(true, DEVON)
    expect(svc.finderQueueLength()).toBe(0)
  })

  it('keeps the newest 50 when messages pile up', () => {
    stop = svc.startNameFinder(deps().d, { worker: false })
    for (let i = 0; i < 60; i++) svc.noteForFinder(true, `message ${i}`)
    expect(svc.finderQueueLength()).toBe(50)
  })
})

describe('drainQueue', () => {
  it('records a found name', async () => {
    const { d } = deps()
    stop = svc.startNameFinder(d, { worker: false })
    svc.noteForFinder(true, DEVON)
    await svc.drainQueue(d)
    expect(sug.nextSuggestion()).toMatchObject({ kind: 'person', value: 'Devon Spencer' })
    expect(svc.finderQueueLength()).toBe(0)
  })

  it('records nothing when the model is off', async () => {
    const { d } = deps({ tagger: { tag: async () => [], disabled: () => true, unloadIfIdle: () => undefined } })
    stop = svc.startNameFinder(d, { worker: false })
    svc.noteForFinder(true, DEVON)
    await svc.drainQueue(d)
    expect(sug.nextSuggestion()).toBeNull()
  })

  it('runs in the background on its own once started', async () => {
    const { d } = deps()
    stop = svc.startNameFinder(d)
    svc.noteForFinder(true, DEVON)
    await vi.waitFor(() => expect(sug.nextSuggestion()).not.toBeNull())
  })
})

describe('offerTick', () => {
  it('sends a card with the two buttons and remembers it', async () => {
    sug.recordFinds([{ kind: 'company', value: 'Bright Path Dental', score: 0.99 }])
    const { d, sent } = deps()
    expect(await svc.offerTick(d)).toBe('sent')
    expect(sent).toEqual([{ text: sug.suggestionText('Bright Path Dental', true), buttons: sug.SUGGESTION_BUTTONS }])
    expect(sug.resolveSuggestionClick(true, 'main:1', 'Add')).toMatch(/^Added Bright Path Dental/)
    expect(d.tagger.unloadIfIdle).toHaveBeenCalled()
  })

  it('holds in quiet hours, while busy, with the filter off, and after three today', async () => {
    sug.recordFinds(['Aa Co', 'Bb Co', 'Cc Co', 'Dd Co'].map((value) => ({ kind: 'company' as const, value, score: 0.99 })))
    quiet.value = { start: '00:00', end: '23:59' }
    expect(await svc.offerTick(deps().d)).toBe('held')
    quiet.value = null
    expect(await svc.offerTick(deps({ busy: () => true }).d)).toBe('held')
    store.setChatPrivacy('main', false)
    expect(await svc.offerTick(deps().d)).toBe('held')
    store.setChatPrivacy('main', true)
    const { d, sent } = deps()
    for (let i = 0; i < 3; i++) expect(await svc.offerTick(d)).toBe('sent')
    expect(await svc.offerTick(d)).toBe('held')
    expect(sent).toHaveLength(3)
  })

  it('returns nothing when there is nothing to offer', async () => {
    expect(await svc.offerTick(deps().d)).toBe('nothing')
  })

  it('leaves the name to try again when the send fails', async () => {
    sug.recordFinds([{ kind: 'company', value: 'Bright Path Dental', score: 0.99 }])
    const { d } = deps({ send: async () => Promise.reject(new Error('network')) })
    expect(await svc.offerTick(d)).toBe('failed')
    expect(sug.nextSuggestion()).toMatchObject({ value: 'Bright Path Dental' })
  })
})
