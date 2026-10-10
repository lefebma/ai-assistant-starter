import { describe, it, expect } from 'vitest'
import { runImapAuth, runImapMail, type ImapCliDeps } from '../src/imap/cli.js'
import { compose } from '../src/imap/mail.js'
import { isRedirect, presetFor } from '../src/imap/presets.js'
import {
  accountSecretName,
  listAccounts,
  loadAccount,
  loadPassword,
  normalisePassword,
  passwordSecretName,
  removeAccount,
  saveAccount,
  savePassword,
  type ImapAccount,
} from '../src/imap/store.js'
import { fakeMailbox, fakeSender } from './imap-fakes.js'

function memVault(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed))
  return {
    map: m,
    get: (n: string) => m.get(n),
    set: (n: string, v: string) => void m.set(n, v),
    delete: (n: string) => m.delete(n),
    list: () => [...m.keys()],
  }
}

const YAHOO_ACCT: ImapAccount = {
  address: 'leif@yahoo.com',
  provider: 'Yahoo Mail',
  imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  savesSent: false,
}

function deps(opts: { vault?: ReturnType<typeof memVault>; verifyFails?: string; stdin?: string } = {}) {
  const vault = opts.vault ?? memVault()
  const box = fakeMailbox()
  const sender = fakeSender()
  const verified: { account: ImapAccount; password: string }[] = []
  const connected: string[] = []
  let closed = 0
  const d: ImapCliDeps = {
    vault,
    timeZone: 'America/Toronto',
    readStdin: async () => opts.stdin ?? '',
    verify: async (account, password) => {
      verified.push({ account, password })
      if (opts.verifyFails) throw new Error(opts.verifyFails)
    },
    connect: async (account) => {
      connected.push(account.address)
      return { mailbox: box, sender, close: async () => void closed++ }
    },
  }
  return { d, vault, box, sender, verified, connected, closed: () => closed }
}

describe('presets', () => {
  it('knows Yahoo in its regional and legacy domains', () => {
    for (const a of ['a@yahoo.com', 'a@yahoo.ca', 'a@yahoo.co.uk', 'a@ymail.com', 'a@rocketmail.com']) {
      const p = presetFor(a)
      expect(p && !isRedirect(p) && p.imap.host).toBe('imap.mail.yahoo.com')
    }
  })

  it('sends Gmail and Microsoft addresses to their own connectors', () => {
    expect(isRedirect(presetFor('a@gmail.com'))).toBe(true)
    for (const a of ['a@outlook.com', 'a@hotmail.com', 'a@live.ca', 'a@msn.com']) {
      const p = presetFor(a)
      expect(isRedirect(p) && p.redirect).toBe('outlook')
    }
  })

  it('has no preset for an unknown domain', () => {
    expect(presetFor('leif@leifbecker.com')).toBeNull()
  })

  it('uses STARTTLS only where the provider requires it', () => {
    const p = presetFor('a@icloud.com')
    expect(p && !isRedirect(p) && p.smtp).toEqual({ host: 'smtp.mail.me.com', port: 587, secure: false })
  })
})

describe('store', () => {
  it('names entries so /secret set accepts the password name', () => {
    expect(passwordSecretName('Leif.Becker@yahoo.com')).toBe('IMAP_PASSWORD_LEIF_BECKER_YAHOO_COM')
    expect(passwordSecretName('leif@yahoo.com')).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/)
    expect(accountSecretName('leif@yahoo.com')).toBe('IMAP_ACCOUNT_LEIF_YAHOO_COM')
  })

  it('refuses an address too long to name a password after', () => {
    expect(() => passwordSecretName(`${'x'.repeat(60)}@yahoo.com`)).toThrow(/too long/)
  })

  it('strips the spaces app passwords are displayed with', () => {
    expect(normalisePassword(' abcd efgh\tijkl mnop \n')).toBe('abcdefghijklmnop')
    const v = memVault({ IMAP_PASSWORD_LEIF_YAHOO_COM: 'abcd efgh ijkl mnop' })
    expect(loadPassword('leif@yahoo.com', v)).toBe('abcdefghijklmnop')
  })

  it('saves, lists and removes both entries', () => {
    const v = memVault()
    saveAccount(YAHOO_ACCT, v)
    savePassword(YAHOO_ACCT.address, 'pw', v)
    expect(loadAccount('leif@yahoo.com', v)).toEqual(YAHOO_ACCT)
    expect(listAccounts(v).map((a) => a.address)).toEqual(['leif@yahoo.com'])
    expect(removeAccount('leif@yahoo.com', v)).toBe(true)
    expect(v.list()).toEqual([])
  })

  it('treats a corrupt entry as not connected rather than failing', () => {
    const v = memVault({ IMAP_ACCOUNT_LEIF_YAHOO_COM: '{not json', IMAP_ACCOUNT_X: '{"address":"x@aol.com"}' })
    expect(loadAccount('leif@yahoo.com', v)).toBeNull()
    expect(listAccounts(v)).toEqual([])
  })
})

describe('imap-auth add', () => {
  it('without a password, explains how to store one and saves nothing', async () => {
    const t = deps()
    const out = await runImapAuth(['add', '--account', 'leif@yahoo.com'], t.d)
    expect(out).toContain('/secret set IMAP_PASSWORD_LEIF_YAHOO_COM')
    expect(out).toContain('Generate app password')
    expect(t.verified).toHaveLength(0)
    expect(t.vault.list()).toEqual([])
  })

  it('with a password from /secret, checks the sign-in and connects', async () => {
    const t = deps({ vault: memVault({ IMAP_PASSWORD_LEIF_YAHOO_COM: 'abcd efgh ijkl mnop' }) })
    const out = await runImapAuth(['add', '--account', 'leif@yahoo.com'], t.d)
    expect(out).toBe('Connected leif@yahoo.com (Yahoo Mail). Reading and sending both work.')
    expect(t.verified[0]!.password).toBe('abcdefghijklmnop')
    expect(loadAccount('leif@yahoo.com', t.vault)).toEqual(YAHOO_ACCT)
  })

  it('takes the password from stdin when asked', async () => {
    const t = deps({ stdin: 'secret-pw\n' })
    await runImapAuth(['add', '--account', 'leif@yahoo.com', '--password-stdin'], t.d)
    expect(t.vault.get('IMAP_PASSWORD_LEIF_YAHOO_COM')).toBe('secret-pw')
  })

  it('does not mark the mailbox connected when the sign-in fails', async () => {
    const t = deps({ vault: memVault({ IMAP_PASSWORD_LEIF_YAHOO_COM: 'bad' }), verifyFails: 'Yahoo Mail refused the sign-in' })
    await expect(runImapAuth(['add', '--account', 'leif@yahoo.com'], t.d)).rejects.toThrow(/refused/)
    expect(t.vault.get(accountSecretName('leif@yahoo.com'))).toBeUndefined()
  })

  it('points Gmail and Outlook addresses at their own skills', async () => {
    await expect(runImapAuth(['add', '--account', 'a@gmail.com'], deps().d)).rejects.toThrow(/Gmail skill/)
    await expect(runImapAuth(['add', '--account', 'a@hotmail.com'], deps().d)).rejects.toThrow(/ms-auth start/)
  })

  it('needs server names for an unknown provider, and uses them when given', async () => {
    await expect(runImapAuth(['add', '--account', 'me@custom.org'], deps().d)).rejects.toThrow(/--imap-host/)
    const t = deps({ vault: memVault({ IMAP_PASSWORD_ME_CUSTOM_ORG: 'pw' }) })
    await runImapAuth(
      ['add', '--account', 'me@custom.org', '--imap-host', 'mail.custom.org', '--smtp-host', 'mail.custom.org', '--smtp-port', '587'],
      t.d
    )
    expect(loadAccount('me@custom.org', t.vault)).toMatchObject({
      imap: { host: 'mail.custom.org', port: 993, secure: true },
      smtp: { host: 'mail.custom.org', port: 587, secure: false },
    })
  })

  it('rejects something that is not an address', async () => {
    await expect(runImapAuth(['add', '--account', 'leif'], deps().d)).rejects.toThrow(/does not look like an email/)
  })
})

describe('imap-auth status and remove', () => {
  it('lists connected mailboxes without signing in unless asked to check', async () => {
    const v = memVault()
    saveAccount(YAHOO_ACCT, v)
    savePassword(YAHOO_ACCT.address, 'pw', v)
    const t = deps({ vault: v })
    expect(await runImapAuth(['status'], t.d)).toBe('leif@yahoo.com: connected (Yahoo Mail, imap.mail.yahoo.com)')
    expect(t.verified).toHaveLength(0)
    expect(await runImapAuth(['status', '--check'], t.d)).toBe('leif@yahoo.com: connected and working (Yahoo Mail)')
  })

  it('says when nothing is connected', async () => {
    expect(await runImapAuth(['status'], deps().d)).toBe('No IMAP mailbox is connected.')
  })

  it('removes a mailbox and reminds the owner to revoke the app password', async () => {
    const v = memVault()
    saveAccount(YAHOO_ACCT, v)
    const out = await runImapAuth(['remove', '--account', 'leif@yahoo.com'], deps({ vault: v }).d)
    expect(out).toMatch(/Revoke the app password/)
    expect(v.list()).toEqual([])
  })
})

describe('imap-mail', () => {
  function connectedDeps() {
    const v = memVault()
    saveAccount(YAHOO_ACCT, v)
    savePassword(YAHOO_ACCT.address, 'pw', v)
    return deps({ vault: v })
  }

  it('prints usage for no command and refuses an unknown one', async () => {
    expect(await runImapMail([], deps().d)).toMatch(/^usage: imap-mail/)
    await expect(runImapMail(['frobnicate'], deps().d)).rejects.toThrow(/Unknown command/)
  })

  it('says how to connect when nothing is connected', async () => {
    await expect(runImapMail(['inbox'], deps().d)).rejects.toThrow(/imap-auth add/)
  })

  it('needs --account when several mailboxes are connected', async () => {
    const t = connectedDeps()
    saveAccount({ ...YAHOO_ACCT, address: 'leif@aol.com' }, t.vault)
    await expect(runImapMail(['inbox'], t.d)).rejects.toThrow(/Say which with --account/)
  })

  it('names the connected mailboxes when asked for another', async () => {
    await expect(runImapMail(['inbox', '--account', 'x@yahoo.com'], connectedDeps().d)).rejects.toThrow(/leif@yahoo.com is/)
  })

  it('catches argument mistakes before opening a connection', async () => {
    const t = connectedDeps()
    await expect(runImapMail(['draft', '--subject', 's', '--body', 'b'], t.d)).rejects.toThrow(/needs --to/)
    await expect(runImapMail(['read'], t.d)).rejects.toThrow(/needs a message id/)
    expect(t.connected).toHaveLength(0)
  })

  it('lists the inbox in the owner time zone and closes the connection', async () => {
    const t = connectedDeps()
    const raw = await compose({ from: 'jane@example.com', to: ['leif@yahoo.com'], subject: 'Hello', body: 'b' })
    t.box.put('INBOX', raw, { subject: 'Hello', from: 'jane@example.com', date: '2026-10-09T14:00:00.000Z' })
    const out = await runImapMail(['inbox'], t.d)
    expect(out).toContain('Hello')
    expect(out).toContain('2026-10-09 10:00')
    expect(out).toMatch(/id INBOX:\d+/)
    expect(t.closed()).toBe(1)
  })

  it('drafts, then sends only with --approved', async () => {
    const t = connectedDeps()
    const drafted = await runImapMail(['draft', '--to', 'bob@x.com', '--subject', 'Hi', '--body', 'Hello'], t.d)
    const id = /id (\S+)\)/.exec(drafted)![1]!
    expect(drafted).toContain('Nothing was sent')
    await expect(runImapMail(['send', id], t.d)).rejects.toThrow(/explicit approval/)
    expect(await runImapMail(['send', id, '--approved'], t.d)).toBe('Sent to bob@x.com.')
    expect(t.sender.sent[0]!.envelope.from).toBe('leif@yahoo.com')
  })

  it('explains a missing app password instead of failing to sign in', async () => {
    const v = memVault()
    saveAccount(YAHOO_ACCT, v)
    await expect(runImapMail(['inbox'], deps({ vault: v }).d)).rejects.toThrow(/\/secret set IMAP_PASSWORD_LEIF_YAHOO_COM/)
  })
})
