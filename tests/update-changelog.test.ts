import { describe, it, expect } from 'vitest'
import { extractChangelogSection } from '../src/update/changelog.js'

const CHANGELOG = `# Changelog

## Unreleased

## 1.22.0 - 2026-09-04

Context and coverage.

- **Added: reply context.** Details.

## 1.21.0 - 2026-09-02

Voice on a phone.

- **Added: voice picker.**
`

describe('extractChangelogSection', () => {
  it('returns the entry for the requested version, not the first section', () => {
    const out = extractChangelogSection(CHANGELOG, '1.22.0')
    expect(out).toContain('## 1.22.0 - 2026-09-04')
    expect(out).toContain('reply context')
    expect(out).not.toContain('Unreleased')
    expect(out).not.toContain('voice picker')
  })

  it('accepts a leading v', () => {
    expect(extractChangelogSection(CHANGELOG, 'v1.21.0')).toContain('voice picker')
  })

  it('returns null for a version with no entry', () => {
    expect(extractChangelogSection(CHANGELOG, '1.23.0')).toBeNull()
  })

  it('returns null for an entry with an empty body (the Unreleased case)', () => {
    expect(extractChangelogSection(CHANGELOG, 'Unreleased')).toBeNull()
  })

  it('handles the last entry in the file', () => {
    const out = extractChangelogSection(CHANGELOG, '1.21.0')
    expect(out).toContain('## 1.21.0 - 2026-09-02')
    expect(out?.endsWith('- **Added: voice picker.**')).toBe(true)
  })

  it('handles CRLF line endings', () => {
    const out = extractChangelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '1.22.0')
    expect(out).toContain('reply context')
  })
})
