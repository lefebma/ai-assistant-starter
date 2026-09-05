/**
 * tests/session-rotation.test.ts
 * Rotation policy (message/age budgets, env parsing) and rotateSession flow
 * with the DB layer mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  getSessionMeta: vi.fn(),
  clearSession: vi.fn(),
  insertMemory: vi.fn(),
}))
vi.mock('../src/db.js', () => db)
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { rotationConfig, needsRotation, rotateSession, SUMMARY_PROMPT } from '../src/session-rotation.js'

const HOUR = 3_600_000

describe('rotationConfig', () => {
  it('is fully disabled by default', () => {
    expect(rotationConfig({})).toEqual({ maxMessages: 0, maxAgeHours: 0, summary: true })
  })

  it('parses positive integers and ignores junk', () => {
    expect(rotationConfig({ SESSION_MAX_MESSAGES: '150', SESSION_MAX_AGE_HOURS: 'abc', SESSION_ROTATE_SUMMARY: 'FALSE' }))
      .toEqual({ maxMessages: 150, maxAgeHours: 0, summary: false })
    expect(rotationConfig({ SESSION_MAX_MESSAGES: '-5' }).maxMessages).toBe(0)
  })
})

describe('needsRotation', () => {
  const now = 1_000 * HOUR
  const meta = (messageCount: number, ageHours: number) => ({ sessionId: 's', createdAt: now - ageHours * HOUR, messageCount })

  it('never rotates without a session or with everything disabled', () => {
    expect(needsRotation(null, { maxMessages: 10, maxAgeHours: 1, summary: true }, now)).toBe(false)
    expect(needsRotation(meta(9999, 9999), { maxMessages: 0, maxAgeHours: 0, summary: true }, now)).toBe(false)
  })

  it('rotates at the message budget', () => {
    const cfg = { maxMessages: 100, maxAgeHours: 0, summary: true }
    expect(needsRotation(meta(99, 0), cfg, now)).toBe(false)
    expect(needsRotation(meta(100, 0), cfg, now)).toBe(true)
  })

  it('rotates at the age budget', () => {
    const cfg = { maxMessages: 0, maxAgeHours: 48, summary: true }
    expect(needsRotation(meta(0, 47), cfg, now)).toBe(false)
    expect(needsRotation(meta(0, 48), cfg, now)).toBe(true)
  })
})

describe('rotateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.getSessionMeta.mockReturnValue({ sessionId: 'old-session-id', createdAt: Date.now() - HOUR, messageCount: 5 })
  })

  it('does nothing when the chat has no session', async () => {
    db.getSessionMeta.mockReturnValue(null)
    const run = vi.fn()
    expect(await rotateSession('c1', { maxMessages: 1, maxAgeHours: 0, summary: true }, run)).toEqual({ rotated: false, summary: null })
    expect(run).not.toHaveBeenCalled()
    expect(db.clearSession).not.toHaveBeenCalled()
  })

  it('summarises the old session into semantic memory, then clears it', async () => {
    const run = vi.fn().mockResolvedValue('  Open: fix the bot. User prefers terse replies.  ')
    const res = await rotateSession('c1', { maxMessages: 1, maxAgeHours: 0, summary: true }, run)
    expect(run).toHaveBeenCalledWith(SUMMARY_PROMPT, 'old-session-id')
    expect(res).toEqual({ rotated: true, summary: 'Open: fix the bot. User prefers terse replies.' })
    const [chatId, content, sector] = db.insertMemory.mock.calls[0]
    expect(chatId).toBe('c1')
    expect(content).toMatch(/^Session handoff \(\d{4}-\d{2}-\d{2}\): Open: fix the bot/)
    expect(sector).toBe('semantic')
    expect(db.clearSession).toHaveBeenCalledWith('c1')
  })

  it('skips the summary turn when disabled', async () => {
    const run = vi.fn()
    const res = await rotateSession('c1', { maxMessages: 1, maxAgeHours: 0, summary: false }, run)
    expect(run).not.toHaveBeenCalled()
    expect(db.insertMemory).not.toHaveBeenCalled()
    expect(res.rotated).toBe(true)
    expect(db.clearSession).toHaveBeenCalledWith('c1')
  })

  it('still rotates when the summary run throws or returns nothing', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('rate limited'))
    expect((await rotateSession('c1', { maxMessages: 1, maxAgeHours: 0, summary: true }, boom)).rotated).toBe(true)
    const empty = vi.fn().mockResolvedValue(null)
    expect(await rotateSession('c1', { maxMessages: 1, maxAgeHours: 0, summary: true }, empty)).toEqual({ rotated: true, summary: null })
    expect(db.insertMemory).not.toHaveBeenCalled()
    expect(db.clearSession).toHaveBeenCalledTimes(2)
  })
})
