import { describe, it, expect } from 'vitest'
import { parseShasums, nodeDistName } from '../src/installer/node-dist.js'

describe('parseShasums', () => {
  const SHASUMS = [
    'aaa111 node-v20.20.2-darwin-arm64.tar.gz',
    'bbb222  node-v20.20.2-win-x64.zip',
    'ccc333\tnode-v20.20.2-linux-x64.tar.gz',
  ].join('\n')

  it('finds the hash for a filename regardless of separator', () => {
    expect(parseShasums(SHASUMS, 'node-v20.20.2-darwin-arm64.tar.gz')).toBe('aaa111')
    expect(parseShasums(SHASUMS, 'node-v20.20.2-win-x64.zip')).toBe('bbb222')
  })

  it('throws for an unknown filename (never silently unverified)', () => {
    expect(() => parseShasums(SHASUMS, 'node-v20.20.2-aix-ppc64.tar.gz')).toThrow(/not found/)
  })
})

describe('nodeDistName', () => {
  it('maps platform/arch to the official dist filenames', () => {
    expect(nodeDistName('darwin', 'arm64', '20.20.2')).toBe('node-v20.20.2-darwin-arm64.tar.gz')
    expect(nodeDistName('darwin', 'x64', '20.20.2')).toBe('node-v20.20.2-darwin-x64.tar.gz')
    expect(nodeDistName('linux', 'x64', '20.20.2')).toBe('node-v20.20.2-linux-x64.tar.gz')
    expect(nodeDistName('win32', 'x64', '20.20.2')).toBe('node-v20.20.2-win-x64.zip')
    expect(nodeDistName('win32', 'arm64', '20.20.2')).toBe('node-v20.20.2-win-arm64.zip')
  })
})
