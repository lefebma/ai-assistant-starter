import { describe, it, expect } from 'vitest'
import { checkRequirements, planBuildStep } from '../src/setup/requirements.js'

describe('checkRequirements', () => {
  it('fails fatally below Node 20', () => {
    const r = checkRequirements({ nodeVersion: '18.19.0', bundledClaude: '/i/claude', signedIn: true })
    expect(r.fatal).toContain('v18.19.0')
  })

  it('never tells anyone to npm install a global Claude CLI', () => {
    // The old check probed PATH and, finding nothing, printed
    // "npm install -g @anthropic-ai/claude-code". That installs a second copy
    // the assistant never calls and does nothing about the missing account.
    const r = checkRequirements({ nodeVersion: '20.20.2', bundledClaude: null, signedIn: false })
    const all = [...r.warnings, ...r.notes, r.fatal ?? ''].join(' ')
    expect(all).not.toMatch(/npm install -g/)
    expect(all).not.toMatch(/@anthropic-ai\/claude-code/)
  })

  it('a missing bundled engine warns without blocking (an API-key install never launches it)', () => {
    const r = checkRequirements({ nodeVersion: '20.20.2', bundledClaude: null, signedIn: false })
    expect(r.fatal).toBeNull()
    expect(r.warnings.join(' ')).toMatch(/engine missing/i)
  })

  it('reports the sign-in state either way, so setup can act on it', () => {
    const out = checkRequirements({ nodeVersion: '20.20.2', bundledClaude: '/i/claude', signedIn: false })
    expect(out.notes.join(' ')).toMatch(/not signed in/i)

    const inn = checkRequirements({ nodeVersion: '20.20.2', bundledClaude: '/i/claude', signedIn: true })
    expect(inn.warnings).toEqual([])
    expect(inn.notes.join(' ')).toMatch(/signed in on this machine/i)
    expect(inn.notes.join(' ')).toContain('v20.20.2')
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
