/**
 * Card #237: the guard and role logs live in the audit store, and the audit
 * log is on by default on self-installs, in a per-user folder outside the
 * install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAuditDir } from '../src/config.js'
import { evidenceDir, evidenceLogPath, resetEvidenceLogs } from '../src/assurance/evidence-logs.js'
import { AuditLog, storeTouch } from '../src/assurance/audit-log.js'

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

describe('the carry-over cannot be used to plant entries (review)', () => {
  let root: string, store: string, audit: string
  beforeEach(() => {
    resetEvidenceLogs()
    root = mkdtempSync(join(tmpdir(), 'evcarry-'))
    store = join(root, 'install', 'store')
    audit = join(root, 'audit')
    mkdirSync(store, { recursive: true })
  })

  it('happens once ever: a file put back in store/ after a restart is ignored', () => {
    writeFileSync(join(store, 'role-log.jsonl'), '{"a":1}\n')
    const path = evidenceLogPath('role-log.jsonl', store, audit)
    resetEvidenceLogs() // a new process
    writeFileSync(join(store, 'role-log.jsonl'), '{"forged":true}\n')
    evidenceLogPath('role-log.jsonl', store, audit)
    expect(readFileSync(path, 'utf-8')).toBe('{"a":1}\n')
  })

  it('takes only JSON object lines from a regular file, never through a symlink', () => {
    writeFileSync(join(store, 'tool-guard.jsonl'), '{"ok":1}\nnot json\n[1,2]\n"str"\n')
    expect(readFileSync(evidenceLogPath('tool-guard.jsonl', store, audit), 'utf-8')).toBe('{"ok":1}\n')

    resetEvidenceLogs()
    const audit2 = join(root, 'audit2')
    const secret = join(root, 'secret.json')
    writeFileSync(secret, '{"token":"x"}\n')
    symlinkSync(secret, join(store, 'role-log.jsonl'))
    const p = evidenceLogPath('role-log.jsonl', store, audit2)
    expect(existsSync(p)).toBe(false)
  })
})

describe('the shell cannot reach the store by another spelling (review)', () => {
  const realHome = process.env.HOME
  let home: string, dir: string, log: AuditLog
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'evhome-'))
    process.env.HOME = home
    dir = join(home, 'Library', 'Application Support', 'Havn', 'audit', 'abc123def456')
    log = new AuditLog({ dir, workspace: join(home, 'havn') })
  })
  afterEach(() => { process.env.HOME = realHome })

  const touch = (command: string) => storeTouch(log, { kind: 'bash', command })

  it('refuses ~, $HOME, escaped spaces, globs, parents and the log names', () => {
    for (const c of [
      'rm ~/Library/Application\\ Support/Havn/audit/abc123def456/tool-guard.jsonl',
      'rm "$HOME/Library/Application Support/Havn/audit/abc123def456/role-log.jsonl"',
      'truncate -s0 ${HOME}/Library/Application\\ Support/Havn/audit/abc123def456/audit.jsonl',
      'rm -rf ~/Library/Application\\ Support/Havn',
      'rm -rf ~/Library/Application\\ Support/Havn/audit/*',
      'rm ~/Library/App*/Havn/audit/*/tool-guard.jsonl',
      'find ~ -name role-log.jsonl | xargs rm',
    ]) expect(touch(c), c).not.toBeNull()
  })

  it('leaves ordinary work alone', () => {
    for (const c of ['ls ~/Library/Application\\ Support', 'rm -rf ~/Library/Application\\ Support/OtherApp', 'git status', 'rm /tmp/x.jsonl']) {
      expect(touch(c), c).toBeNull()
    }
  })
})
