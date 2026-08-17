import { describe, it, expect } from 'vitest'
import { buildSupportDraft, formatDraftPreview } from '../src/support/draft.js'
import type { SupportDiagnostics } from '../src/support/diagnostics.js'

const SUPPORT = 'support@els-partners.com'

function diag(overrides: Partial<SupportDiagnostics> = {}): SupportDiagnostics {
  return {
    appVersion: '1.15.0',
    os: 'darwin 25.6.0 (arm64)',
    node: 'v22.11.0',
    enabledSkillIds: ['gmail', 'weather'],
    errorLogTail: ['{"level":50,"msg":"send failed: ETIMEDOUT"}'],
    ...overrides,
  }
}

describe('buildSupportDraft', () => {
  it('addresses the configured support inbox and stamps the version in the subject', () => {
    const d = buildSupportDraft('The bot stopped replying', diag(), SUPPORT)
    expect(d.to).toBe(SUPPORT)
    expect(d.subject).toContain('1.15.0')
  })

  it('carries the user description verbatim plus every diagnostic field', () => {
    const d = buildSupportDraft('Scheduler fires twice every morning', diag(), SUPPORT)
    expect(d.body).toContain('Scheduler fires twice every morning')
    expect(d.body).toContain('App version: 1.15.0')
    expect(d.body).toContain('OS: darwin 25.6.0 (arm64)')
    expect(d.body).toContain('Node: v22.11.0')
    expect(d.body).toContain('Enabled skills: gmail, weather')
    expect(d.body).toContain('ETIMEDOUT')
  })

  it('says so plainly when there are no error log lines', () => {
    const d = buildSupportDraft('Nothing in the logs', diag({ errorLogTail: [] }), SUPPORT)
    expect(d.body).toContain('(no error log lines found)')
  })

  it('shows (none) when no skills are enabled', () => {
    const d = buildSupportDraft('desc', diag({ enabledSkillIds: [] }), SUPPORT)
    expect(d.body).toContain('Enabled skills: (none)')
  })

  it('defense in depth: redacts the diagnostics block even if a secret slipped past collection', () => {
    // Assembled at runtime so secret scanners never match the fixture in source.
    const fakeToken = ['xox', 'b-1234567890-abcdefghijklmnop'].join('')
    const d = buildSupportDraft(
      'desc',
      diag({ errorLogTail: [`ERROR auth: SLACK_TOKEN=${fakeToken} for bob@corp.com`] }),
      SUPPORT
    )
    expect(d.body).not.toContain(fakeToken)
    expect(d.body).not.toContain('bob@corp.com')
  })
})

describe('formatDraftPreview', () => {
  it('shows destination, subject, body, and an explicit not-sent-yet note', () => {
    const d = buildSupportDraft('Something is off', diag(), SUPPORT)
    const preview = formatDraftPreview(d)
    expect(preview).toContain(`To: ${SUPPORT}`)
    expect(preview).toContain('Subject:')
    expect(preview).toContain('Something is off')
    expect(preview).toContain('Nothing has been sent yet.')
  })
})
