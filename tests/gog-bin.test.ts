import { describe, it, expect } from 'vitest'
import { gogCandidates, resolveGogBin } from '../src/infra/gog-bin.js'

const nothingExists = () => false
const onlyAt = (...hits: string[]) => (p: string) => hits.includes(p)

describe('gogCandidates', () => {
  it('looks for gog.exe on Windows, not a bare gog', () => {
    const paths = gogCandidates('win32', 'C:\\Users\\sam')
    expect(paths.every((p) => p.endsWith('gog.exe'))).toBe(true)
  })

  it('covers both Homebrew prefixes on macOS', () => {
    const paths = gogCandidates('darwin', '/Users/sam')
    expect(paths).toContain('/opt/homebrew/bin/gog') // Apple Silicon
    expect(paths).toContain('/usr/local/bin/gog') // Intel
  })

  it('includes a user-local bin so a non-admin install is found', () => {
    expect(gogCandidates('linux', '/home/sam')).toContain('/home/sam/.local/bin/gog')
  })
})

describe('resolveGogBin', () => {
  it('prefers an explicit GOG_BIN override over anything on disk', () => {
    const bin = resolveGogBin({ GOG_BIN: '/custom/gog' }, 'darwin', '/Users/sam', onlyAt('/opt/homebrew/bin/gog'))
    expect(bin).toBe('/custom/gog')
  })

  it('finds the Intel Homebrew path when the Apple Silicon one is absent', () => {
    const bin = resolveGogBin({}, 'darwin', '/Users/sam', onlyAt('/usr/local/bin/gog'))
    expect(bin).toBe('/usr/local/bin/gog')
  })

  it('finds the Windows binary', () => {
    const bin = resolveGogBin({}, 'win32', 'C:\\Users\\sam', onlyAt('C:\\Users\\sam\\.local\\bin\\gog.exe'))
    expect(bin).toBe('C:\\Users\\sam\\.local\\bin\\gog.exe')
  })

  // A service started by launchd or Task Scheduler gets a minimal PATH, which
  // is why absolute candidates are checked first. But falling back to the bare
  // name still beats returning null: an interactive run, or a machine that put
  // gog somewhere unusual, resolves through PATH and works.
  it('falls back to the bare command name when nothing is on disk', () => {
    expect(resolveGogBin({}, 'darwin', '/Users/sam', nothingExists)).toBe('gog')
    expect(resolveGogBin({}, 'win32', 'C:\\Users\\sam', nothingExists)).toBe('gog.exe')
  })

  it('ignores a blank GOG_BIN rather than trying to execute an empty string', () => {
    expect(resolveGogBin({ GOG_BIN: '   ' }, 'darwin', '/Users/sam', nothingExists)).toBe('gog')
  })
})
