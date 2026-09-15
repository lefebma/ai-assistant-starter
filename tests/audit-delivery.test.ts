/**
 * /audit digest has to survive being long.
 *
 * renderDigest quotes up to 60 turns at 160 characters each, so a busy box
 * produces roughly 11,000 characters. Telegram's ceiling is 4096 and Teams'
 * is 8000, so sending it in one call does not truncate, it fails. The first
 * version of the command did exactly that.
 */
import { describe, it, expect } from 'vitest'
import { deliverText, deliverFenced } from '../src/bot.js'
import { collectAudit, SAMPLE_LIMIT, SAMPLE_CHARS, type AuditIO } from '../src/audit/digest.js'
import { renderDigest } from '../src/audit/report.js'

function fakeAdapter(limit: number) {
  const sent: string[] = []
  return {
    sent,
    maxMessageLength: limit,
    formatText: (s: string) => s,
    splitMessage: (s: string) => {
      const out: string[] = []
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
      return out
    },
    sendMessage: async (_chat: string, text: string) => {
      if (text.length > limit) throw new Error(`message too long: ${text.length} > ${limit}`)
      sent.push(text)
      return String(sent.length)
    },
  }
}

function busyDigest(): string {
  const turns = Array.from({ length: 400 }, (_, i) => ({
    at: Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000) + i * 60,
    text: `question number ${i} ${'x'.repeat(200)}`,
  }))
  const io: AuditIO = {
    turns: () => turns,
    tasks: () => [],
    enabledSkills: () => [],
    matchTurn: () => [],
    tokenUsage: () => ({ available: false, runs: 0, totalTokens: 0, models: [] }),
    goals: () => ({ profileWritten: false, prioritiesRecorded: false }),
    now: () => Math.floor(Date.parse('2026-09-15T12:00:00Z') / 1000),
    timeZone: () => 'America/Toronto',
  }
  return renderDigest(collectAudit('c', io))
}

describe('a busy box produces a digest no platform will take whole', () => {
  it('is longer than Telegram allows', () => {
    expect(busyDigest().length).toBeGreaterThan(4096)
  })

  it('quotes at most SAMPLE_LIMIT turns, which is what makes it that long', () => {
    expect(SAMPLE_LIMIT * SAMPLE_CHARS).toBeGreaterThan(4096)
  })
})

describe('deliverText', () => {
  it('splits a long body so no single send exceeds the platform limit', async () => {
    const a = fakeAdapter(4096)
    await deliverText(a as never, 'chat', busyDigest())
    expect(a.sent.length).toBeGreaterThan(1)
    for (const chunk of a.sent) expect(chunk.length).toBeLessThanOrEqual(4096)
  })

  it('preserves the whole body across the chunks', async () => {
    const a = fakeAdapter(4096)
    const body = busyDigest()
    await deliverText(a as never, 'chat', body)
    expect(a.sent.join('')).toBe(body)
  })

  it('sends a short body as one message', async () => {
    const a = fakeAdapter(4096)
    await deliverText(a as never, 'chat', 'short')
    expect(a.sent).toEqual(['short'])
  })

  it('runs the body through the platform formatter', async () => {
    const a = fakeAdapter(4096)
    a.formatText = (s: string) => `FORMATTED:${s}`
    await deliverText(a as never, 'chat', 'hello')
    expect(a.sent).toEqual(['FORMATTED:hello'])
  })
})

describe('deliverFenced', () => {
  it('closes the fence on every chunk, not just the last', async () => {
    const a = fakeAdapter(600)
    await deliverFenced(a as never, 'chat', busyDigest())
    expect(a.sent.length).toBeGreaterThan(1)
    for (const chunk of a.sent) {
      expect(chunk.startsWith('```\n')).toBe(true)
      expect(chunk.endsWith('\n```')).toBe(true)
      // An unbalanced fence renders the rest of the message as code, or as
      // literal backticks, depending on the client.
      expect((chunk.match(/```/g) ?? []).length).toBe(2)
    }
  })

  it('keeps every chunk inside the platform limit once the fence is added', async () => {
    const a = fakeAdapter(600)
    await deliverFenced(a as never, 'chat', busyDigest())
    for (const chunk of a.sent) expect(chunk.length).toBeLessThanOrEqual(600)
  })

  it('preserves the body once the fences are stripped', async () => {
    const a = fakeAdapter(600)
    const body = busyDigest()
    await deliverFenced(a as never, 'chat', body)
    const rejoined = a.sent.map((c) => c.slice(4, -4)).join('')
    expect(rejoined).toBe(body)
  })

  it('sends a short body as a single fenced message', async () => {
    const a = fakeAdapter(600)
    await deliverFenced(a as never, 'chat', 'two\nlines')
    expect(a.sent).toEqual(['```\ntwo\nlines\n```'])
  })
})
