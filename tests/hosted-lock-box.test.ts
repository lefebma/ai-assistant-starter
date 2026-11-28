/** Card #308 quick fix: journal logs, no ssh for havn, operators through havn-admin. */
import { describe, it, expect } from 'vitest'
import { asHavnArgs } from '../scripts/hosted/box-ssh.js'
import { CHECK, LOCK } from '../scripts/hosted/lock-box.js'
import { readJournalTail } from '../src/support/diagnostics.js'

describe('lock-box', () => {
  it('refuses to run before havn-admin has its own keys, so it cannot lock the operator out', () => {
    expect(LOCK.indexOf('test -s /home/havn-admin/.ssh/authorized_keys')).toBeLessThan(LOCK.indexOf('DenyUsers havn'))
  })

  it('moves both units to the journal with a drop-in and denies havn in sshd, testing the config first', () => {
    expect(LOCK).toContain('StandardOutput=journal')
    expect(LOCK).toContain('StandardError=journal')
    expect(LOCK).toContain('20-journal.conf')
    expect(LOCK).toContain('usermod -aG systemd-journal havn')
    expect(LOCK.indexOf('sshd -t')).toBeLessThan(LOCK.indexOf('try-reload-or-restart ssh.service'))
    expect(LOCK).not.toMatch(/Standard(Output|Error)=append:/)
  })

  it('checks what it set: journal output, sshd denying havn, the journal group', () => {
    expect(CHECK).toContain('StandardOutput StandardError')
    expect(CHECK).toContain('denyusers')
    expect(CHECK).toContain('systemd-journal')
    expect(CHECK).toContain('CHECK_OK')
  })
})

describe('operator scripts reach havn through havn-admin', () => {
  it('logs in as havn-admin and drops to havn in its home', () => {
    const args = asHavnArgs('box.example')
    expect(args).toContain('havn-admin@box.example')
    expect(args.join(' ')).not.toMatch(/(^|\s)havn@/)
    expect(args.at(-1)).toContain('sudo -n -u havn -H')
    expect(args).toContain('BatchMode=yes')
  })
})

describe('support diagnostics read the journal on a hosted box', () => {
  it('uses the journal when it has the unit, and falls back to the file when it does not', () => {
    if (process.platform !== 'linux') {
      expect(readJournalTail((() => 'x') as never)).toBeNull()
      return
    }
    expect(readJournalTail((() => 'line one\nline two\n') as never)).toContain('line two')
    expect(readJournalTail((() => '') as never)).toBeNull()
    expect(readJournalTail((() => { throw new Error('no journalctl') }) as never)).toBeNull()
  })
})
