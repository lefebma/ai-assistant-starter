import { describe, it, expect, beforeAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

// Own SQLite store for this file, set before src/config.js is evaluated
// (vi.hoisted runs ahead of the hoisted imports). Other files share the
// default AGENT_STORE_DIR and would race on one database file otherwise.
const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-teams-conversations`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import {
  initTeamsTables,
  upsertConversation,
  getConversation,
  hasProcessedActivity,
  markActivityProcessed,
} from '../src/platform/teams/conversations.js'

describe('teams conversation store', () => {
  beforeAll(() => {
    initTeamsTables()
    initTeamsTables() // idempotent
  })

  it('round-trips a reference and updates it in place', () => {
    upsertConversation({ conversationId: 'a:1', serviceUrl: 'https://s1/', botId: '28:bot', userId: 'aad-1', tenantId: 't1' })
    expect(getConversation('a:1')).toEqual({ conversationId: 'a:1', serviceUrl: 'https://s1/', botId: '28:bot', userId: 'aad-1', tenantId: 't1' })
    upsertConversation({ conversationId: 'a:1', serviceUrl: 'https://s2/', botId: '28:bot', userId: 'aad-1' })
    expect(getConversation('a:1')?.serviceUrl).toBe('https://s2/')
    expect(getConversation('a:1')?.tenantId).toBeUndefined()
  })

  it('returns null for an unknown conversation', () => {
    expect(getConversation('a:nope')).toBeNull()
  })

  it('remembers processed activity ids', () => {
    expect(hasProcessedActivity('act-1')).toBe(false)
    markActivityProcessed('act-1')
    expect(hasProcessedActivity('act-1')).toBe(true)
    markActivityProcessed('act-1') // no throw on repeat
  })
})
