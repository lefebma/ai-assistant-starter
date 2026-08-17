import { describe, it, expect } from 'vitest'
import {
  collectDiagnostics,
  extractErrorLines,
  isErrorLogLine,
  ERROR_LOG_TAIL_LINES,
  type DiagnosticsIO,
} from '../src/support/diagnostics.js'

function fakeIO(overrides: Partial<DiagnosticsIO> = {}): DiagnosticsIO {
  return {
    appVersion: () => '1.15.0',
    osInfo: () => 'darwin 25.6.0 (arm64)',
    nodeVersion: () => 'v22.11.0',
    enabledSkillIds: () => ['gmail', 'weather'],
    readLogTailRaw: () => null,
    ...overrides,
  }
}

describe('isErrorLogLine', () => {
  it('recognises pino JSON error and fatal levels', () => {
    expect(isErrorLogLine('{"level":50,"msg":"boom"}')).toBe(true)
    expect(isErrorLogLine('{"level":60,"msg":"dead"}')).toBe(true)
  })

  it('ignores pino info/warn levels', () => {
    expect(isErrorLogLine('{"level":30,"msg":"fine"}')).toBe(false)
    expect(isErrorLogLine('{"level":40,"msg":"meh"}')).toBe(false)
  })

  it('recognises pretty-printed ERROR/FATAL lines', () => {
    expect(isErrorLogLine('[12:01:02] ERROR: something broke')).toBe(true)
    expect(isErrorLogLine('[12:01:02] FATAL: gone')).toBe(true)
    expect(isErrorLogLine('[12:01:02] INFO: all good')).toBe(false)
  })
})

describe('extractErrorLines', () => {
  it('keeps only error-level lines', () => {
    const raw = [
      '{"level":30,"msg":"started"}',
      '{"level":50,"msg":"first failure"}',
      '{"level":30,"msg":"still going"}',
      '{"level":50,"msg":"second failure"}',
    ].join('\n')
    expect(extractErrorLines(raw)).toEqual([
      '{"level":50,"msg":"first failure"}',
      '{"level":50,"msg":"second failure"}',
    ])
  })

  it('caps at the LAST N lines (the most recent failures)', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `{"level":50,"msg":"err ${i}"}`).join('\n')
    const out = extractErrorLines(raw)
    expect(out).toHaveLength(ERROR_LOG_TAIL_LINES)
    expect(out[out.length - 1]).toContain('err 49')
    expect(out[0]).toContain(`err ${50 - ERROR_LOG_TAIL_LINES}`)
  })

  it('returns empty for a log with no errors', () => {
    expect(extractErrorLines('{"level":30,"msg":"quiet day"}')).toEqual([])
  })
})

describe('collectDiagnostics', () => {
  it('collects version, os, node, and enabled skill ids only', () => {
    const d = collectDiagnostics(fakeIO())
    expect(d.appVersion).toBe('1.15.0')
    expect(d.os).toBe('darwin 25.6.0 (arm64)')
    expect(d.node).toBe('v22.11.0')
    expect(d.enabledSkillIds).toEqual(['gmail', 'weather'])
  })

  it('returns an empty log tail when no log file exists', () => {
    const d = collectDiagnostics(fakeIO({ readLogTailRaw: () => null }))
    expect(d.errorLogTail).toEqual([])
  })

  it('redacts secrets and emails in the log tail before anything else sees it', () => {
    const raw = [
      '{"level":50,"msg":"send failed for marc@example.com"}',
      '{"level":50,"msg":"retry with OPENAI_API_KEY=sk-proj-secretsecret123"}',
      '{"level":30,"msg":"TELEGRAM_BOT_TOKEN=8123456789:AAHnotanerrorline should be dropped"}',
    ].join('\n')
    const d = collectDiagnostics(fakeIO({ readLogTailRaw: () => raw }))

    const joined = d.errorLogTail.join('\n')
    expect(d.errorLogTail).toHaveLength(2)
    expect(joined).not.toContain('marc@example.com')
    expect(joined).not.toContain('sk-proj-secretsecret123')
    expect(joined).toContain('[email redacted]')
    expect(joined).toContain('OPENAI_API_KEY=')
    // The info-level line (with its token) was filtered out entirely
    expect(joined).not.toContain('AAHnotanerrorline')
  })
})
