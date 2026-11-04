/**
 * Card #237: the guard and role logs live in the audit store, and the audit
 * log is on by default on self-installs, in a per-user folder outside the
 * install.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAuditDir } from '../src/config.js'
import { evidenceDir, evidenceLogPath, resetEvidenceLogs } from '../src/assurance/evidence-logs.js'

const NO_HOSTED = '/nonexistent-havn-audit'

describe('the audit log is on by default outside the install', () => {
  it('uses the platform app-data folder, one per install', () => {
    const mac = defaultAuditDir('/Users/a/havn', 'darwin', { HOME: '/Users/a' })
    expect(mac).toMatch(/^\/Users\/a\/Library\/Application Support\/Havn\/audit\/[0-9a-f]{12}$/)
    const linux = defaultAuditDir('/home/a/havn', 'linux', { HOME: '/home/a' })
    expect(linux).toMatch(/^\/home\/a\/\.local\/state\/havn\/audit\/[0-9a-f]{12}$/)
    expect(defaultAuditDir('/home/a/havn', 'linux', { HOME: '/home/a', XDG_STATE_HOME: '/s' })).toMatch(/^\/s\/havn\/audit\//)
    const win = defaultAuditDir('C:\\havn', 'win32', { USERPROFILE: 'C:\\Users\\a', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })
    expect(win).toContain('Havn')
    // Two installs never share a chain.
    expect(defaultAuditDir('/Users/a/havn2', 'darwin', { HOME: '/Users/a' })).not.toBe(mac)
  })

  it('tests get none unless they set AUDIT_DIR', () => {
    expect(defaultAuditDir('/x', 'darwin', { HOME: '/h', VITEST: 'true' })).toBe('')
  })
})

describe('guard and role logs move into the audit store', () => {
  let root: string, store: string, audit: string
  beforeEach(() => {
    resetEvidenceLogs()
    root = mkdtempSync(join(tmpdir(), 'evlogs-'))
    store = join(root, 'install', 'store')
    audit = join(root, 'audit')
    mkdirSync(store, { recursive: true })
  })

  it('stay in store/ with auditing off', () => {
    expect(evidenceLogPath('tool-guard.jsonl', store, null)).toBe(join(store, 'tool-guard.jsonl'))
  })

  it('go in the audit store when it is on, carrying old lines over once', () => {
    writeFileSync(join(store, 'tool-guard.jsonl'), '{"at":"2026-11-01T00:00:00Z","a":1}\n{"at":"2026-11-02T00:00:00Z","a":2}')
    const path = evidenceLogPath('tool-guard.jsonl', store, audit)
    expect(path).toBe(join(audit, 'tool-guard.jsonl'))
    expect(readFileSync(path, 'utf-8')).toBe('{"at":"2026-11-01T00:00:00Z","a":1}\n{"at":"2026-11-02T00:00:00Z","a":2}\n')
    expect(existsSync(join(store, 'tool-guard.jsonl'))).toBe(false)
    expect(existsSync(join(store, 'tool-guard.jsonl.moved'))).toBe(true)
    // A second call (or a new file in store/ later) does not copy again in this process.
    writeFileSync(join(store, 'tool-guard.jsonl'), 'stray\n')
    evidenceLogPath('tool-guard.jsonl', store, audit)
    expect(readFileSync(path, 'utf-8')).not.toContain('stray')
  })

  it('never uses an audit store inside the install', () => {
    const install = join(root, 'install')
    expect(evidenceDir(join(install, 'audit'), install, NO_HOSTED)).toBeNull()
    expect(evidenceDir(root, install, NO_HOSTED)).toBeNull()
    expect(evidenceDir(audit, install, NO_HOSTED)).toBe(audit)
    expect(evidenceDir('', install, NO_HOSTED)).toBeNull()
  })
})
