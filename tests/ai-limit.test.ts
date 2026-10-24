import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isManagedAi, readAiLimit, writeAiLimit, clearAiLimit, classifyAiError,
  recoveryDue, ownerPauseReply, aiPausedForBackground, AI_LIMIT_FILE, MANAGED_AI_FILE, type AiLimitMarker,
} from '../src/ai-limit.js'

const dir = () => mkdtempSync(join(tmpdir(), 'ai-limit-'))
const MIN = 60_000
const FIRST = "I've reached this month's AI allowance, so I'm paused for now. Your provider has been told and will be in touch."
const REPEAT = "Still paused: this month's AI allowance is used up. Your provider has been told."

describe('managed flag and marker', () => {
  it('isManagedAi follows the file', () => {
    const d = dir()
    expect(isManagedAi(d)).toBe(false)
    writeFileSync(join(d, MANAGED_AI_FILE), '{}')
    expect(isManagedAi(d)).toBe(true)
  })
  it('round-trips, tolerates corruption, clears safely', () => {
    const d = dir()
    expect(readAiLimit(d)).toBeNull()
    const m: AiLimitMarker = { kind: 'billing', since: '2026-10-01T00:00:00.000Z', lastRequestId: 'req_1' }
    writeAiLimit(m, d)
    expect(readAiLimit(d)).toEqual(m)
    clearAiLimit(d)
    expect(existsSync(join(d, AI_LIMIT_FILE))).toBe(false)
    expect(() => clearAiLimit(d)).not.toThrow()
    writeFileSync(join(d, AI_LIMIT_FILE), '{oops')
    expect(readAiLimit(d)).toBeNull()
  })
})

describe('classifyAiError', () => {
  // Real text captured on 2026-10-24 (task A9), in the three shapes it arrives in.
  it('the raw API body for a workspace spend limit, with its request id', () => {
    expect(classifyAiError('{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."},"request_id":"req_011CgMGEbecbvCqrYAnAs5MR"}'))
      .toEqual({ kind: 'spend_limit', requestId: 'req_011CgMGEbecbvCqrYAnAs5MR' })
  })
  it('the CLI result text for a workspace spend limit (no request id)', () => {
    expect(classifyAiError('API Error: 400 You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'))
      .toEqual({ kind: 'spend_limit' })
  })
  it('the SDK error thrown for a workspace spend limit', () => {
    expect(classifyAiError('Claude Code returned an error result: API Error: 400 You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'))
      .toEqual({ kind: 'spend_limit' })
  })
  it('ordinary 400 is null', () => {
    expect(classifyAiError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill"}}')).toBeNull()
  })
  it('a bare 402 token never classifies as billing', () => {
    expect(classifyAiError('at file:///app/node_modules/cli.js:402:15')).toBeNull()
    expect(classifyAiError('request took 402 ms')).toBeNull()
  })

  it('billing needs billing_error, API Error: 402, or "status":402', () => {
    expect(classifyAiError('API Error: 402 Payment required')?.kind).toBe('billing')
    expect(classifyAiError('{"status":402,"message":"nope"}')?.kind).toBe('billing')
    expect(classifyAiError('{"type":"billing_error"}')?.kind).toBe('billing')
  })

  it('402 billing_error', () => {
    expect(classifyAiError('API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Payment required"}}')?.kind).toBe('billing')
  })
  it('429 spend cap is org_cap', () => {
    expect(classifyAiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Your organization has hit its spend cap"}}')?.kind).toBe('org_cap')
  })
  it('per-minute 429 is null', () => {
    expect(classifyAiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toBeNull()
  })
  it('subscription text is null', () => {
    expect(classifyAiError('Claude AI usage limit reached')).toBeNull()
  })
})

describe('recoveryDue', () => {
  const since = '2026-10-01T00:00:00.000Z'
  const t = new Date(since).getTime()
  it('15 minute threshold from since', () => {
    expect(recoveryDue({ kind: 'billing', since }, new Date(t + 14 * MIN))).toBe(false)
    expect(recoveryDue({ kind: 'billing', since }, new Date(t + 15 * MIN))).toBe(true)
  })
  it('uses lastProbeAt when set', () => {
    const m: AiLimitMarker = { kind: 'billing', since, lastProbeAt: new Date(t + 60 * MIN).toISOString() }
    expect(recoveryDue(m, new Date(t + 70 * MIN))).toBe(false)
    expect(recoveryDue(m, new Date(t + 75 * MIN))).toBe(true)
  })
})

describe('ownerPauseReply', () => {
  const since = '2026-10-01T00:00:00.000Z'
  const now = new Date('2026-10-01T01:00:00.000Z')
  it('first, silent, then repeat after 24h', () => {
    const first = ownerPauseReply({ kind: 'spend_limit', since }, now)!
    expect(first.text).toBe(FIRST)
    expect(first.next.toldFull).toBe(true)
    expect(first.next.lastToldAt).toBe(now.toISOString())
    expect(ownerPauseReply(first.next, new Date(now.getTime() + 60 * MIN))).toBeNull()
    const rep = ownerPauseReply(first.next, new Date(now.getTime() + 25 * 60 * MIN))!
    expect(rep.text).toBe(REPEAT)
    expect(rep.next.lastToldAt).toBe(new Date(now.getTime() + 25 * 60 * MIN).toISOString())
  })
})

describe('aiPausedForBackground', () => {
  it('is true only on a managed box with a marker, due or not', () => {
    const d = dir()
    expect(aiPausedForBackground(d)).toBe(false)
    // A marker on a non-managed box does not pause anything.
    writeAiLimit({ kind: 'spend_limit', since: '2020-01-01T00:00:00.000Z' }, d)
    expect(aiPausedForBackground(d)).toBe(false)
    writeFileSync(join(d, MANAGED_AI_FILE), '{}')
    // Recovery long due: background work still skips; the recovery timer probes.
    expect(aiPausedForBackground(d)).toBe(true)
    clearAiLimit(d)
    expect(aiPausedForBackground(d)).toBe(false)
  })
})
