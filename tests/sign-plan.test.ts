import { describe, it, expect } from 'vitest'
import {
  parseCodesign,
  planBinary,
  nodeEntitlements,
  distributionXml,
  TEAM_ID_PATTERN,
} from '../src/sign/plan.js'

// Real `codesign -dvv --entitlements :-` output, trimmed to the lines that matter.
const AD_HOC = `Executable=/tmp/better_sqlite3.node
Identifier=better_sqlite3
CodeDirectory v=20400 size=14732 flags=0x20002(adhoc,linker-signed) hashes=457+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set`

const OUR_TEAM = `Executable=/tmp/thing.node
CodeDirectory v=20500 size=696560 flags=0x10000(runtime) hashes=21757+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Marc Lefebvre (H2DZ4DJQAV)
Authority=Developer ID Certification Authority
TeamIdentifier=H2DZ4DJQAV`

const VENDOR_CLEAN = `Executable=/tmp/claude
CodeDirectory v=20500 size=1605477 flags=0x10000(runtime) hashes=50160+7 location=embedded
Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
TeamIdentifier=Q6L2SF6YDW`

const VENDOR_DEBUG = `Executable=/tmp/node
CodeDirectory v=20500 size=696560 flags=0x10000(runtime) hashes=21757+7 location=embedded
Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)
TeamIdentifier=HX7739G8FX`

describe('parseCodesign', () => {
  it('recognises an ad-hoc linker signature as unsigned for our purposes', () => {
    const info = parseCodesign(AD_HOC, [])
    expect(info.adHoc).toBe(true)
    expect(info.teamId).toBeNull()
  })

  it('reads the team out of a real Developer ID signature', () => {
    expect(parseCodesign(VENDOR_CLEAN, []).teamId).toBe('Q6L2SF6YDW')
    expect(parseCodesign(VENDOR_CLEAN, []).adHoc).toBe(false)
  })

  it('reports hardened runtime from the CodeDirectory flags', () => {
    expect(parseCodesign(VENDOR_CLEAN, []).hardened).toBe(true)
    expect(parseCodesign(AD_HOC, []).hardened).toBe(false)
  })

  it('flags the debug entitlement notarisation rejects', () => {
    expect(parseCodesign(VENDOR_DEBUG, ['com.apple.security.get-task-allow']).hasGetTaskAllow).toBe(true)
    expect(parseCodesign(VENDOR_CLEAN, ['com.apple.security.cs.allow-jit']).hasGetTaskAllow).toBe(false)
  })
})

describe('planBinary', () => {
  const ours = 'H2DZ4DJQAV'

  it('signs an ad-hoc addon, because notarisation rejects it', () => {
    const d = planBinary(parseCodesign(AD_HOC, []), ours)
    expect(d.action).toBe('sign')
  })

  it('leaves a clean third-party Developer ID binary alone', () => {
    const d = planBinary(parseCodesign(VENDOR_CLEAN, ['com.apple.security.cs.allow-jit']), ours)
    expect(d.action).toBe('skip')
  })

  it('re-signs a third-party binary carrying get-task-allow', () => {
    const d = planBinary(parseCodesign(VENDOR_DEBUG, ['com.apple.security.get-task-allow']), ours)
    expect(d.action).toBe('re-sign')
    expect(d.reason).toMatch(/get-task-allow/)
  })

  it('leaves our own already-correct signature alone', () => {
    const d = planBinary(parseCodesign(OUR_TEAM, []), ours)
    expect(d.action).toBe('skip')
  })

  it('re-signs anything of ours that somehow lost hardened runtime', () => {
    const info = { ...parseCodesign(OUR_TEAM, []), hardened: false }
    expect(planBinary(info, ours).action).toBe('re-sign')
  })
})

describe('nodeEntitlements', () => {
  const plist = nodeEntitlements()

  it('drops the entitlement Apple refuses to notarise', () => {
    expect(plist).not.toContain('get-task-allow')
  })

  it('keeps what V8 and native addons actually need', () => {
    for (const e of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
    ]) {
      expect(plist).toContain(e)
    }
  })

  it('is a parseable plist', () => {
    expect(plist).toMatch(/^<\?xml/)
    expect(plist).toContain('</plist>')
  })
})

describe('distributionXml', () => {
  const xml = distributionXml({ title: 'Havn', componentPkg: 'havn-app.pkg', identifier: 'com.havn.app', version: '1.14.2' })

  it('installs into the user home so no admin password is needed', () => {
    expect(xml).toContain('enable_currentUserHome="true"')
    expect(xml).toContain('enable_localSystem="false"')
  })

  it('references the component package it was built with', () => {
    expect(xml).toContain('havn-app.pkg')
    expect(xml).toContain('com.havn.app')
  })
})

describe('TEAM_ID_PATTERN', () => {
  it('matches a real team id and not a stray word', () => {
    expect(TEAM_ID_PATTERN.test('H2DZ4DJQAV')).toBe(true)
    expect(TEAM_ID_PATTERN.test('not set')).toBe(false)
  })
})
