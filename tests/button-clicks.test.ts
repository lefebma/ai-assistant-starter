import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE = mkdtempSync(join(tmpdir(), 'havn-buttons-'))
process.env['AGENT_STORE_DIR'] = STORE

let claimButtonClick: typeof import('../src/db.js').claimButtonClick

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  claimButtonClick = db.claimButtonClick
})

afterAll(async () => {
  try {
    const { getDb } = await import('../src/db.js')
    getDb().close()
  } catch {
    // no handle to close
  }
  try {
    rmSync(STORE, { recursive: true, force: true })
  } catch {
    // the OS reaps its own temp directory
  }
})

describe('claimButtonClick', () => {
  it('lets the first click through', () => {
    expect(claimButtonClick('chat1', 'card-a', 'Send').claimed).toBe(true)
  })

  it('refuses a second click on the same card and reports what was chosen', () => {
    claimButtonClick('chat1', 'card-b', 'Send')
    const second = claimButtonClick('chat1', 'card-b', 'Send')
    expect(second.claimed).toBe(false)
    expect(second.existingLabel).toBe('Send')
  })

  it('refuses a different button on an already-answered card', () => {
    // The dangerous shape: approve, then hit Discard on the same still-visible
    // card. Only the first answer counts.
    claimButtonClick('chat1', 'card-c', 'Send')
    const later = claimButtonClick('chat1', 'card-c', 'Discard')
    expect(later.claimed).toBe(false)
    expect(later.existingLabel).toBe('Send')
  })

  it('keeps cards independent, so answering one does not lock the next', () => {
    expect(claimButtonClick('chat1', 'card-d', 'Send').claimed).toBe(true)
    expect(claimButtonClick('chat1', 'card-e', 'Send').claimed).toBe(true)
  })

  it('keeps chats independent, since message ids are only unique per conversation', () => {
    expect(claimButtonClick('chatA', 'same-id', 'Send').claimed).toBe(true)
    expect(claimButtonClick('chatB', 'same-id', 'Send').claimed).toBe(true)
  })

  it('resolves a race to exactly one winner', () => {
    // Two clicks can be in flight at once: Teams processes activities
    // asynchronously, and a double-tap can beat the keyboard clear anywhere.
    // A check-then-write would let both through; the claim is one statement.
    const results = Array.from({ length: 12 }, () =>
      claimButtonClick('chat-race', 'card-race', 'Send')
    )
    expect(results.filter((r) => r.claimed)).toHaveLength(1)
    expect(results.filter((r) => !r.claimed)).toHaveLength(11)
  })
})
