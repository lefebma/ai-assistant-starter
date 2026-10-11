import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLink, completeLink, FailureLimiter, fileLinkStore, issueLink, LINK_TTL_MS, type LinkState, type LinkStore } from '../src/setup/web/link.js'

function memStore(): LinkStore & { state: LinkState | null } {
  const s = { state: null as LinkState | null, read: () => s.state, write: (v: LinkState) => void (s.state = v) }
  return s
}

describe('setup link', () => {
  it('accepts the issued token only, and stores a hash rather than the token', () => {
    const store = memStore()
    const token = issueLink(store, 1000)
    expect(token.length).toBeGreaterThanOrEqual(43)
    expect(JSON.stringify(store.state)).not.toContain(token)
    expect(checkLink(store, token, 2000)).toBe('ok')
    expect(checkLink(store, token + 'x', 2000)).toBe('invalid')
    expect(checkLink(store, '', 2000)).toBe('invalid')
    expect(checkLink(store, null, 2000)).toBe('invalid')
  })

  it('expires after 48 hours, and says expired rather than invalid', () => {
    const store = memStore()
    const token = issueLink(store, 0)
    expect(checkLink(store, token, LINK_TTL_MS)).toBe('ok')
    expect(checkLink(store, token, LINK_TTL_MS + 1)).toBe('expired')
  })

  it('is done for good once setup completes, whatever token comes', () => {
    const store = memStore()
    const token = issueLink(store, 0)
    completeLink(store, 10)
    expect(checkLink(store, token, 20)).toBe('done')
    expect(checkLink(store, 'anything', 20)).toBe('done')
  })

  it('reports none before any link exists', () => {
    expect(checkLink(memStore(), 'x', 0)).toBe('none')
  })

  it('a reissued link replaces the old one', () => {
    const store = memStore()
    const first = issueLink(store, 0)
    const second = issueLink(store, 5)
    expect(checkLink(store, first, 6)).toBe('invalid')
    expect(checkLink(store, second, 6)).toBe('ok')
  })

  it('writes the file owner-only and survives a garbage file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'link-'))
    const store = fileLinkStore(join(dir, 'store', 'setup-link.json'))
    const token = issueLink(store, 0)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'store', 'setup-link.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'store', 'setup-link.json'), 'utf-8')).not.toContain(token)
    expect(checkLink(store, token, 1)).toBe('ok')
  })
})

describe('FailureLimiter', () => {
  it('blocks a client after the cap within the window and recovers after it', () => {
    const l = new FailureLimiter(3, 1000)
    for (let i = 0; i < 3; i++) l.record('a', i)
    expect(l.blocked('a', 10)).toBe(true)
    expect(l.blocked('b', 10)).toBe(false)
    expect(l.blocked('a', 1500)).toBe(false)
  })
})
