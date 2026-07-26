import { describe, it, expect } from 'vitest'
import { checkRequirements } from '../src/setup/requirements.js'

describe('checkRequirements', () => {
  it('fails fatally below Node 20', () => {
    const r = checkRequirements({ nodeVersion: '18.19.0', claudeVersion: () => '1.0.0' })
    expect(r.fatal).toContain('v18.19.0')
  })

  it('a missing Claude CLI is a warning, not a failure (BYOK installs never need it)', () => {
    const r = checkRequirements({ nodeVersion: '20.20.2', claudeVersion: () => null })
    expect(r.fatal).toBeNull()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/AGENT_RUNTIME=ai-sdk/)
    expect(r.warnings[0]).toMatch(/@anthropic-ai\/claude-code/)
  })

  it('reports clean notes when everything is present', () => {
    const r = checkRequirements({ nodeVersion: '20.20.2', claudeVersion: () => '2.1.0' })
    expect(r.fatal).toBeNull()
    expect(r.warnings).toEqual([])
    expect(r.notes.join(' ')).toContain('2.1.0')
    expect(r.notes.join(' ')).toContain('v20.20.2')
  })
})
