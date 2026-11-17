/** Name suggestions: what is offered once, and the card's two answers (card #275). */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['AGENT_STORE_DIR'] = mkdtempSync(join(tmpdir(), 'privacy-finder-'))

let db: typeof import('../src/db.js')
let store: typeof import('../src/privacy/store.js')
let s: typeof import('../src/privacy/finder/suggestions.js')

beforeAll(async () => {
  db = await import('../src/db.js')
  db.initDatabase()
  store = await import('../src/privacy/store.js')
  s = await import('../src/privacy/finder/suggestions.js')
})

beforeEach(() => {
  db.getDb().exec('DELETE FROM privacy_names; DELETE FROM privacy_suggestions')
  store.resetPrivacyCache()
})

const bpd = { kind: 'company' as const, value: 'Bright Path Dental', score: 0.99 }

function offer(card = 'main:42'): number {
  const next = s.nextSuggestion()!
  s.markOffered(next.id, card)
  return next.id
}

describe('recordFinds', () => {
  it('keeps one row for a name seen many times', () => {
    expect(s.recordFinds([bpd])).toBe(1)
    expect(s.recordFinds([bpd, { ...bpd, value: 'bright path dental' }])).toBe(0)
    expect(s.nextSuggestion()).toEqual({ id: expect.any(Number), kind: 'company', value: 'Bright Path Dental' })
  })

  it('skips a name already on the list, in any case or as an alias', () => {
    store.addEntry('company', 'Bright Path Dental Inc', ['Bright Path Dental'])
    expect(s.recordFinds([{ ...bpd, value: 'BRIGHT PATH DENTAL' }])).toBe(0)
    expect(s.nextSuggestion()).toBeNull()
  })

  it('does not offer a name twice', () => {
    s.recordFinds([bpd])
    offer()
    expect(s.nextSuggestion()).toBeNull()
  })
})

describe('the card', () => {
  it('Add puts the name on the list', () => {
    s.recordFinds([bpd])
    offer('main:42')
    expect(s.resolveSuggestionClick(true, 'main:42', 'Add')).toBe('Added Bright Path Dental. It stays on this machine whenever the privacy filter is on.')
    expect(store.findEntry('Bright Path Dental')).toMatchObject({ kind: 'company', value: 'Bright Path Dental', source: 'owner' })
  })

  it('Not private is never asked again', () => {
    s.recordFinds([bpd])
    offer('main:42')
    expect(s.resolveSuggestionClick(true, 'main:42', 'Not private')).toBe("Okay, I won't ask about Bright Path Dental again.")
    expect(store.findEntry('Bright Path Dental')).toBeUndefined()
    expect(s.recordFinds([bpd])).toBe(0)
  })

  it('answers a second tap without changing anything', () => {
    s.recordFinds([bpd])
    offer('main:42')
    s.resolveSuggestionClick(true, 'main:42', 'Not private')
    expect(s.resolveSuggestionClick(true, 'main:42', 'Add')).toBe('Already done.')
    expect(store.findEntry('Bright Path Dental')).toBeUndefined()
  })

  it('only answers in the main chat', () => {
    s.recordFinds([bpd])
    offer('main:42')
    expect(s.resolveSuggestionClick(false, 'main:42', 'Add')).toBe('That one only works in your main chat.')
    expect(store.findEntry('Bright Path Dental')).toBeUndefined()
  })

  it('leaves other cards alone', () => {
    expect(s.resolveSuggestionClick(true, 'main:999', 'Add')).toBeNull()
    s.recordFinds([bpd])
    offer('main:42')
    expect(s.resolveSuggestionClick(true, 'main:42', 'Got it')).toBeNull()
  })

  it('reads plainly, with and without buttons', () => {
    expect(s.suggestionText('Acme', true)).toBe('Keep Acme private? It came up in your messages. Add puts it on your privacy list, so it stays on this machine.')
    expect(s.suggestionText('Acme', false)).toBe('Keep Acme private? It came up in your messages. To keep it private, reply /private add Acme')
    expect(s.SUGGESTION_BUTTONS).toEqual(['Add', 'Not private'])
  })
})

describe('offeredToday', () => {
  it('counts by the local day', () => {
    s.recordFinds([bpd, { kind: 'person', value: 'Jane Doe', score: 0.99 }])
    // 23:30 and 00:30 New York time on either side of midnight.
    const late = Date.parse('2026-11-17T04:30:00Z')
    const early = Date.parse('2026-11-17T05:30:00Z')
    s.markOffered(s.nextSuggestion()!.id, 'main:1', late)
    s.markOffered(s.nextSuggestion()!.id, 'main:2', early)
    expect(s.offeredToday(early, 'America/New_York')).toBe(1)
    expect(s.offeredToday(late, 'America/New_York')).toBe(1)
    expect(s.offeredToday(early, 'UTC')).toBe(2)
  })
})
