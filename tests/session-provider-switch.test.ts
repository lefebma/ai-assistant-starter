import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import type { ModelMessage } from 'ai'
import { reconcileHistory } from '../src/runtime/ai-sdk/history.js'
import { SessionStore } from '../src/runtime/ai-sdk/sessions.js'

const anthropicHistory = [
  { role: 'user', content: 'add 2+2' },
  {
    role: 'assistant',
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    content: [
      { type: 'reasoning', text: 'thinking...', providerOptions: { anthropic: { signature: 'sig123' } } },
      { type: 'text', text: 'It is 4.', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
    ],
  },
] as unknown as ModelMessage[]

describe('reconcileHistory', () => {
  it('returns history untouched when the provider is unchanged', () => {
    const out = reconcileHistory(anthropicHistory, 'anthropic', 'anthropic')
    expect(out).toEqual(anthropicHistory)
  })

  it('strips provider options and reasoning parts on a provider switch', () => {
    const out = reconcileHistory(anthropicHistory, 'anthropic', 'openai') as any[]
    expect(out[0]).toEqual({ role: 'user', content: 'add 2+2' })
    expect(out[1].providerOptions).toBeUndefined()
    expect(out[1].content).toEqual([{ type: 'text', text: 'It is 4.' }])
  })

  it('treats an unknown stored provider as a switch (legacy sessions)', () => {
    const out = reconcileHistory(anthropicHistory, null, 'openai') as any[]
    expect(out[1].content).toEqual([{ type: 'text', text: 'It is 4.' }])
  })

  it('does not mutate the input', () => {
    const before = JSON.stringify(anthropicHistory)
    reconcileHistory(anthropicHistory, 'anthropic', 'google')
    expect(JSON.stringify(anthropicHistory)).toBe(before)
  })
})

describe('SessionStore provider tracking', () => {
  it('stores and returns the provider that wrote the session', () => {
    const store = new SessionStore(new Database(':memory:'))
    store.save('s1', [{ role: 'user', content: 'hi' }], 'anthropic')
    expect(store.loadProvider('s1')).toBe('anthropic')
  })

  it('returns null for unknown sessions and legacy rows', () => {
    const db = new Database(':memory:')
    // Legacy schema from before the provider column existed
    db.exec(`CREATE TABLE ai_sdk_sessions (id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
    db.prepare(`INSERT INTO ai_sdk_sessions VALUES ('legacy', '[]', 0)`).run()
    const store = new SessionStore(db)
    expect(store.loadProvider('legacy')).toBeNull()
    expect(store.loadProvider('nope')).toBeNull()
    // And the migrated table accepts provider-stamped saves
    store.save('s2', [], 'google')
    expect(store.loadProvider('s2')).toBe('google')
  })
})
