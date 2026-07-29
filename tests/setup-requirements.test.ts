import { describe, it, expect } from 'vitest'
import { checkRequirements, planBuildStep } from '../src/setup/requirements.js'

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

describe('planBuildStep', () => {
  it('skips the build on an installer bundle (compiled app, production deps, no toolchain)', () => {
    const d = planBuildStep({ hasCompiledApp: true, hasDependencies: true, hasBuildToolchain: false })
    expect(d.build).toBe(false)
    expect(d.reason).toMatch(/prebuilt/i)
  })

  it('builds on a fresh clone (nothing compiled, no deps yet)', () => {
    const d = planBuildStep({ hasCompiledApp: false, hasDependencies: false, hasBuildToolchain: false })
    expect(d.build).toBe(true)
  })

  it('builds when deps are missing even though a stale dist is present', () => {
    const d = planBuildStep({ hasCompiledApp: true, hasDependencies: false, hasBuildToolchain: false })
    expect(d.build).toBe(true)
  })

  it('builds on a developer clone that already has the toolchain', () => {
    const d = planBuildStep({ hasCompiledApp: true, hasDependencies: true, hasBuildToolchain: true })
    expect(d.build).toBe(true)
  })
})
