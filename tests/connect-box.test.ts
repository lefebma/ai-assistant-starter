import { describe, it, expect } from 'vitest'
import { ConnectFlow, type ConnectTokenVault, type MsTokenStore, type Revoker } from '../src/connect/box.js'
import { signHandoff } from '../src/connect/relay.js'
import { readDriveEntries } from '../src/connect/drive-token.js'
import { readGmailEntries } from '../src/connect/gmail-token.js'

const HKEY = 'box-handoff-key-for-tests-0123456789abcdef'

function memVault(): ConnectTokenVault & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n) }
}

function memMs(): MsTokenStore & { data: Map<string, { accessToken: string; refreshToken: string; expiresAt: number }> } {
  // Slugs labels the way src/ms/store.ts does, so lookups by address and by label agree.
  const slug = (a: string) => a.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const data = new Map<string, { accessToken: string; refreshToken: string; expiresAt: number }>()
  return {
    data,
    save: (a, t) => void data.set(slug(a), t),
    load: (a) => data.get(slug(a)) ?? null,
    clear: (a) => data.delete(slug(a)),
    list: () => [...data.keys()],
  }
}

function setup(revoker?: Revoker) {
  let t = 5_000_000
  const changes: string[] = []
  const vault = memVault()
  const ms = memMs()
  const revoked: string[] = []
  const flow = new ConnectFlow({
    relayUrl: 'https://connect.gethavn.ai',
    boxId: 'box-1',
    handoffKey: HKEY,
    vault,
    msTokens: ms,
    onChange: (p) => void changes.push(p),
    now: () => t,
    revokers: { gmail: revoker ?? (async (tok) => void revoked.push(tok.refreshToken)) },
  })
  const nonceOf = (reply: string) => new URL(reply.match(/https:\/\/\S+/)![0]).searchParams.get('nonce')!
  const body = (nonce: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ nonce, provider: 'gmail', ts: t, account: 'x@y.com', accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, ...over })
  const send = (raw: string, sig = signHandoff(HKEY, raw)) => flow.acceptHandoff(raw, sig)
  return { flow, vault, ms, changes, revoked, nonceOf, body, send, advance: (d: number) => (t += d) }
}

describe('/connect start', () => {
  it('issues a one-time link naming this box and the provider', () => {
    const s = setup()
    const { reply } = s.flow.handleCommand('chat1', '/connect gmail')
    const u = new URL(reply.match(/https:\/\/\S+/)![0])
    expect(u.origin + u.pathname).toBe('https://connect.gethavn.ai/start')
    expect(u.searchParams.get('provider')).toBe('gmail')
    expect(u.searchParams.get('box')).toBe('box-1')
    expect(u.searchParams.get('nonce')!.length).toBeGreaterThanOrEqual(32)
  })
  it('sends yahoo to the /secret flow instead', () => {
    const s = setup()
    expect(s.flow.handleCommand('c', '/connect yahoo').reply).toContain('/secret set')
  })
  it('lists usage for unknown providers', () => {
    expect(setup().flow.handleCommand('c', '/connect nope').reply).toContain('/connect gmail')
  })
})

describe('hand-off acceptance', () => {
  it('stores tokens and confirms to the chat that asked', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect gmail').reply)
    const r = await s.send(s.body(nonce))
    expect(r).toMatchObject({ status: 200, chatId: 'chat1' })
    expect(r.message).toBe('Connected x@y.com, mail and calendar working.')
    expect(JSON.parse(s.vault.data.get('CONNECT_GMAIL')!).accounts['x@y.com']).toMatchObject({ account: 'x@y.com', refreshToken: 'RT' })
    expect(r.message).not.toContain('RT')
  })
  it('replaces an app-password connection to the same Gmail address', async () => {
    const s = setup()
    s.vault.set('IMAP_ACCOUNT_X_Y_COM', JSON.stringify({ address: 'x@y.com' }))
    s.vault.set('IMAP_PASSWORD_X_Y_COM', 'pw')
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect gmail').reply)
    const r = await s.send(s.body(nonce, { account: 'X@y.com' }))
    expect(r.message).toContain('Connected X@y.com, mail and calendar working.')
    expect(r.message).toContain('app password')
    expect(r.message).toContain('myaccount.google.com/apppasswords')
    expect(s.vault.data.has('IMAP_ACCOUNT_X_Y_COM')).toBe(false)
    expect(s.vault.data.has('IMAP_PASSWORD_X_Y_COM')).toBe(false)
  })
  it('leaves an Outlook sign-in alone even when IMAP has the same address', async () => {
    const s = setup()
    s.vault.set('IMAP_ACCOUNT_X_Y_COM', JSON.stringify({ address: 'x@y.com' }))
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect outlook').reply)
    const r = await s.send(s.body(nonce, { provider: 'outlook' }))
    expect(r.message).toBe('Connected x@y.com, mail and calendar working.')
    expect(s.vault.data.has('IMAP_ACCOUNT_X_Y_COM')).toBe(true)
  })
  it('tells the keeper after a connect and after a removal, never after a refusal', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    await s.send(s.body(nonce))
    await s.send(s.body(nonce))
    expect(s.changes).toEqual(['gmail'])
    await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.changes).toEqual(['gmail', 'gmail'])
  })
  it('accepts a state only once', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce))).status).toBe(200)
    s.vault.data.clear()
    expect((await s.send(s.body(nonce))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses a state this box never issued', async () => {
    const s = setup()
    expect((await s.send(s.body('x'.repeat(32)))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses an expired pending state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    s.advance(10 * 60_000 + 1)
    expect((await s.send(s.body(nonce, { ts: 5_000_000 + 10 * 60_000 + 1 }))).status).toBe(403)
    expect(s.vault.data.size).toBe(0)
  })
  it('refuses a bad or missing signature without spending the pending state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce), 'deadbeef')).status).toBe(401)
    expect((await s.send(s.body(nonce), '')).status).toBe(401)
    expect((await s.send(s.body(nonce))).status).toBe(200)
  })
  it('refuses a provider mismatch and spends the state', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce, { provider: 'outlook' }))).status).toBe(403)
    expect((await s.send(s.body(nonce))).status).toBe(403)
  })
  it('refuses a stale timestamp and malformed bodies', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    expect((await s.send(s.body(nonce, { ts: 1 }))).status).toBe(403)
    expect((await s.send('not json')).status).toBe(400)
    const missing = JSON.stringify({ nonce, provider: 'gmail', ts: 5_000_000 })
    expect((await s.send(missing)).status).toBe(400)
  })
})

describe('Outlook hand-off', () => {
  it('lands in the Microsoft token store, in seconds, where the Outlook tools read it', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('chat1', '/connect outlook').reply)
    const r = await s.send(s.body(nonce, { provider: 'outlook', account: 'me@contoso.com', expiresAt: 7_200_500 }))
    expect(r.status).toBe(200)
    expect(s.ms.data.get('ME_CONTOSO_COM')).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 7200 })
    expect(s.vault.data.has('CONNECT_OUTLOOK')).toBe(false)
    expect(s.flow.handleCommand('c', '/connect list').reply).toBe('outlook: ME_CONTOSO_COM')
  })
  it('removes one mailbox by address, and says where to withdraw access at Microsoft', async () => {
    const s = setup()
    for (const account of ['a@x.com', 'b@x.com']) {
      const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect outlook').reply)
      await s.send(s.body(nonce, { provider: 'outlook', account, refreshToken: `RT-${account}` }))
    }
    expect((await s.flow.handleCommandAsync('c', '/connect remove outlook')).reply).toContain('Which mailbox?')
    const r = await s.flow.handleCommandAsync('c', '/connect remove outlook b@x.com')
    expect(r.reply).toContain('account.live.com/consent/Manage')
    expect(r.reply).not.toContain('revoked at the provider')
    expect(s.revoked).toEqual([])
    expect([...s.ms.data.keys()]).toEqual(['A_X_COM'])
  })
  it('removes the only mailbox without naming it', async () => {
    const s = setup()
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect outlook').reply)
    await s.send(s.body(nonce, { provider: 'outlook' }))
    await s.flow.handleCommandAsync('c', '/connect remove outlook --local-only')
    expect(s.ms.data.size).toBe(0)
    expect(s.revoked).toEqual([])
  })
})

describe('/connect remove', () => {
  async function connected(s: ReturnType<typeof setup>) {
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    await s.send(s.body(nonce))
  }
  it('revokes at the provider then deletes locally', async () => {
    const s = setup()
    await connected(s)
    const r = await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.revoked).toEqual(['RT'])
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(false)
    expect(r.reply).toContain('Removed')
  })
  it('keeps the local token when revocation fails, so it can be retried', async () => {
    const s = setup(async () => { throw new Error('network') })
    await connected(s)
    const r = await s.flow.handleCommandAsync('c', '/connect remove gmail')
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(true)
    expect(r.reply).toContain('--local-only')
    const r2 = await s.flow.handleCommandAsync('c', '/connect remove gmail --local-only')
    expect(s.vault.data.has('CONNECT_GMAIL')).toBe(false)
    expect(r2.reply).toContain('not revoked')
  })
  it('says so when nothing is connected', async () => {
    const r = await setup().flow.handleCommandAsync('c', '/connect remove gmail')
    expect(r.reply).toContain('Nothing connected')
  })
})

describe('several Gmail accounts (card #271)', () => {
  async function connect(s: ReturnType<typeof setup>, account: string, rt: string) {
    const nonce = s.nonceOf(s.flow.handleCommand('c', '/connect gmail').reply)
    return s.send(s.body(nonce, { account, refreshToken: rt }))
  }
  const stored = (s: ReturnType<typeof setup>) => Object.keys(JSON.parse(s.vault.data.get('CONNECT_GMAIL')!).accounts)

  it('adds a second account instead of replacing the first, and lists both', async () => {
    const s = setup()
    await connect(s, 'a@gmail.com', 'RT-A')
    await connect(s, 'b@gmail.com', 'RT-B')
    expect(stored(s)).toEqual(['a@gmail.com', 'b@gmail.com'])
    expect(s.flow.handleCommand('c', '/connect list').reply).toBe('gmail: a@gmail.com\ngmail: b@gmail.com')
  })

  it('replaces an account that signs in again, matching the address without case', async () => {
    const s = setup()
    await connect(s, 'a@gmail.com', 'RT-A')
    await connect(s, 'A@Gmail.com', 'RT-A2')
    expect(stored(s)).toEqual(['a@gmail.com'])
    expect(JSON.parse(s.vault.data.get('CONNECT_GMAIL')!).accounts['a@gmail.com'].refreshToken).toBe('RT-A2')
  })

  it('asks which account to remove, then revokes and deletes only that one', async () => {
    const s = setup()
    await connect(s, 'a@gmail.com', 'RT-A')
    await connect(s, 'b@gmail.com', 'RT-B')
    expect((await s.flow.handleCommandAsync('c', '/connect remove gmail')).reply).toContain('Which account?')
    expect(s.revoked).toEqual([])
    expect((await s.flow.handleCommandAsync('c', '/connect remove gmail nope@x.com')).reply).toContain('Nothing connected for gmail nope@x.com')
    const r = await s.flow.handleCommandAsync('c', '/connect remove gmail B@gmail.com')
    expect(r.reply).toContain('Removed gmail b@gmail.com')
    expect(s.revoked).toEqual(['RT-B'])
    expect(stored(s)).toEqual(['a@gmail.com'])
  })

  it('a removal waiting on the relay does not delete a newer sign-in for the same address', async () => {
    let release!: () => void
    const s = setup(async () => new Promise<void>((r) => (release = r)))
    await connect(s, 'a@gmail.com', 'RT-OLD')
    const removing = s.flow.handleCommandAsync('c', '/connect remove gmail a@gmail.com')
    await connect(s, 'a@gmail.com', 'RT-NEW')
    release()
    expect((await removing).reply).toContain('stays connected')
    expect(JSON.parse(s.vault.data.get('CONNECT_GMAIL')!).accounts['a@gmail.com'].refreshToken).toBe('RT-NEW')
  })

  it('reads a box connected before #271 (one account, old shape) and keeps it when adding another', async () => {
    const s = setup()
    s.vault.data.set('CONNECT_GMAIL', JSON.stringify({ account: 'old@gmail.com', accessToken: 'AT', refreshToken: 'RT-OLD', expiresAt: 1 }))
    expect(s.flow.handleCommand('c', '/connect list').reply).toBe('gmail: old@gmail.com')
    await connect(s, 'new@gmail.com', 'RT-NEW')
    expect(stored(s)).toEqual(['old@gmail.com', 'new@gmail.com'])
  })

  it('marks an account whose grant was withdrawn', () => {
    const s = setup()
    s.vault.data.set('CONNECT_GMAIL', JSON.stringify({ accounts: { 'a@gmail.com': { account: 'a@gmail.com', accessToken: 'x', refreshToken: 'y', expiresAt: 1, revoked: true } } }))
    expect(s.flow.handleCommand('c', '/connect list').reply).toBe('gmail: a@gmail.com (needs /connect gmail again)')
  })
})

describe('/connect drive (card #284)', () => {
  const linkIn = (reply: string) => reply.match(/https:\/\/\S+/)![0]
  async function connectDrive(s: ReturnType<typeof setup>, account = 'm@x.com') {
    const nonce = s.nonceOf(s.flow.handleCommand('c1', '/connect drive').reply)
    return s.send(s.body(nonce, { provider: 'drive', account, accessToken: 'DRIVE-AT', refreshToken: 'DRIVE-RT' }))
  }
  it('/connect drive gives a one-time link for provider drive', () => {
    const s = setup()
    expect(new URL(linkIn(s.flow.handleCommand('c1', '/connect drive').reply)).searchParams.get('provider')).toBe('drive')
  })
  it('usage lists drive', () => {
    const reply = setup().flow.handleCommand('c', '/connect nope').reply
    expect(reply).toContain('/connect drive - see your Google Drive in the files panel (read only)')
    expect(reply).toContain('/connect remove drive <account> - forget Drive on this box')
  })
  it('a drive hand-off is stored apart from Gmail and leaves IMAP alone', async () => {
    const s = setup()
    saveGmail(s, 'm@x.com')
    s.vault.set('IMAP_ACCOUNT_M_X_COM', JSON.stringify({ address: 'm@x.com' }))
    const r = await connectDrive(s)
    expect(r).toMatchObject({ status: 200, chatId: 'c1', message: 'Connected m@x.com. Google Drive is now in the files panel, read only.' })
    expect(readDriveEntries(s.vault).has('m@x.com')).toBe(true)
    expect(readGmailEntries(s.vault).get('m@x.com')!.accessToken).toBe('GMAIL-AT')
    expect(s.vault.get('IMAP_ACCOUNT_M_X_COM')).toBeDefined()
    expect(s.changes).toEqual(['drive'])
  })
  it('/connect list shows drive accounts', async () => {
    const s = setup()
    await connectDrive(s)
    expect(s.flow.handleCommand('c1', '/connect list').reply).toContain('drive: m@x.com')
  })
  it('flags a drive account whose grant was withdrawn', () => {
    const s = setup()
    s.vault.set('CONNECT_DRIVE', JSON.stringify({ accounts: { 'm@x.com': { account: 'm@x.com', accessToken: 'a', refreshToken: 'r', expiresAt: 1, revoked: true } } }))
    expect(s.flow.handleCommand('c1', '/connect list').reply).toContain('drive: m@x.com (needs /connect drive again)')
  })
  it('removing Drive is local only and never calls the relay', async () => {
    const s = setup()
    await connectDrive(s)
    const out = await s.flow.handleCommandAsync('c1', '/connect remove drive m@x.com')
    expect(s.revoked).toEqual([])
    expect(readDriveEntries(s.vault).size).toBe(0)
    expect(out.reply).toBe('Removed Google Drive for m@x.com from this box. To withdraw the permission at Google, remove Havn under myaccount.google.com/connections; that also disconnects its Gmail.')
    expect(s.changes).toEqual(['drive', 'drive'])
  })
  it('asks which account when several are connected, and handles unknown or none', async () => {
    const s = setup()
    expect((await s.flow.handleCommandAsync('c1', '/connect remove drive')).reply).toBe('Nothing connected for drive.')
    await connectDrive(s, 'a@x.com')
    await connectDrive(s, 'b@x.com')
    expect((await s.flow.handleCommandAsync('c1', '/connect remove drive')).reply).toContain('Which account? /connect remove drive <a@x.com|b@x.com>')
    expect((await s.flow.handleCommandAsync('c1', '/connect remove drive nope@x.com')).reply).toContain('Nothing connected for drive nope@x.com')
    expect(readDriveEntries(s.vault).size).toBe(2)
  })
  it("removing Gmail also drops that address's Drive and says so", async () => {
    const s = setup()
    saveGmail(s, 'm@x.com')
    await connectDrive(s)
    const out = await s.flow.handleCommandAsync('c1', '/connect remove gmail m@x.com')
    expect(s.revoked).toEqual(['GMAIL-RT'])
    expect(readDriveEntries(s.vault).has('m@x.com')).toBe(false)
    expect(out.reply).toContain('This also disconnected Google Drive for that account.')
    expect(s.changes).toEqual(['drive', 'drive', 'gmail'])
  })
  it('removing Gmail for an address without Drive says nothing about Drive', async () => {
    const s = setup()
    saveGmail(s, 'm@x.com')
    await connectDrive(s, 'other@x.com')
    const out = await s.flow.handleCommandAsync('c1', '/connect remove gmail m@x.com')
    expect(out.reply).not.toContain('Google Drive')
    expect(readDriveEntries(s.vault).has('other@x.com')).toBe(true)
  })
  it('a local-only Gmail removal revokes nothing, so Drive stays', async () => {
    const s = setup()
    saveGmail(s, 'm@x.com')
    await connectDrive(s)
    const out = await s.flow.handleCommandAsync('c1', '/connect remove gmail m@x.com --local-only')
    expect(readDriveEntries(s.vault).has('m@x.com')).toBe(true)
    expect(out.reply).not.toContain('Google Drive')
  })
  it('a failed Gmail revocation keeps Drive too', async () => {
    const s = setup(async () => { throw new Error('network') })
    saveGmail(s, 'm@x.com')
    await connectDrive(s)
    await s.flow.handleCommandAsync('c1', '/connect remove gmail m@x.com')
    expect(readDriveEntries(s.vault).has('m@x.com')).toBe(true)
  })
})

function saveGmail(s: ReturnType<typeof setup>, account: string) {
  s.vault.set('CONNECT_GMAIL', JSON.stringify({ accounts: { [account]: { account, accessToken: 'GMAIL-AT', refreshToken: 'GMAIL-RT', expiresAt: 1 } } }))
}
