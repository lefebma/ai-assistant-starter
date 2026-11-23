/** Approving a refused site from chat (card #306). */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

const h = vi.hoisted(() => {
  process.env['AGENT_STORE_DIR'] = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'egress-approvals-'))
  return { live: { allow: '', read: 'docs.example.org,*.gov', approver: 'owner' as 'owner' | 'operator' } }
})

vi.mock('../src/config.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, liveEgressSettings: (file?: string) => (file ? (real.liveEgressSettings as (f: string) => unknown)(file) : h.live) }
})

import { liveEgressSettings } from '../src/config.js'
import { getDb, initDatabase } from '../src/db.js'
import { approvableHost, decide, expandRules } from '../src/egress/policy.js'
import { collectRefusedSites, currentProxy, noteRefused, withEgress } from '../src/egress/index.js'
import { ALLOW, ASK, DENY, NOT_NEEDED, buttonsFor, egressCommand, markOffered, offerText, resolveSiteClick, sitesToOffer } from '../src/egress/approvals.js'

const authOf = (proxyUrl: string) => { const u = new URL(proxyUrl); return `Basic ${Buffer.from(`${u.username}:${u.password}`).toString('base64')}` }

beforeEach(() => {
  initDatabase()
  getDb().exec('DELETE FROM egress_sites')
  h.live = { allow: '', read: 'docs.example.org,*.gov', approver: 'owner' }
})

describe('which names can be approved', () => {
  it('takes one public host name, lowercased', () => {
    expect(approvableHost('Example.COM')).toBe('example.com')
    expect(approvableHost('api.open-meteo.com.')).toBe('api.open-meteo.com')
  })

  it.each(['1.1.1.1', '[::1]', '*.example.com', 'example.com:8443', '@google', 'localhost', 'printer.local', 'db.internal', 'nas.lan', 'x.home.arpa', 'intranet', 'a..b', '-bad.com', 'example.123', '', 'http://example.com', 'evil.com\n.org', 'a.com\nEGRESS=off', 'a b.com'])('refuses %s', (v) => {
    expect(approvableHost(v)).toBeNull()
  })
})

describe('the proxy marks a site refused only for being on no list', () => {
  it('flags an unlisted host, not a read-only write or a wrong port', () => {
    const p = { name: 'chat', write: expandRules([]), read: expandRules(['docs.example.org']) }
    expect(decide(p, { host: 'example.com', port: 443, method: null })).toMatchObject({ allow: false, unlisted: true })
    expect(decide(p, { host: 'docs.example.org', port: 80, method: 'POST' })).not.toHaveProperty('unlisted')
  })

  it('collects only web ports, without repeats', () => {
    const s = new Set<string>()
    const d = { method: 'CONNECT', path: '', decision: 'denied' as const, unlisted: true }
    noteRefused(s, { ...d, host: 'Example.com', port: 443 })
    noteRefused(s, { ...d, host: 'example.com', port: 443 })
    noteRefused(s, { ...d, host: 'other.org', port: 22 })
    noteRefused(s, { ...d, host: 'listed.org', port: 443, unlisted: false })
    noteRefused(undefined, { ...d, host: 'nobody.org', port: 443 })
    expect([...s]).toEqual(['example.com'])
  })

  it('a real refused CONNECT inside a chat turn comes back from collectRefusedSites', async () => {
    const cfg = { approved: [], read: [], imapHosts: () => [] }
    const { sites } = await collectRefusedSites(() => withEgress({ enforce: true, cfg, record: () => {} }, async () => {
      const url = new URL(currentProxy()!)
      await new Promise<void>((done) => {
        const s = connect(Number(url.port), '127.0.0.1', () => s.write(`CONNECT blocked.example.net:443 HTTP/1.1\r\nProxy-Authorization: ${authOf(currentProxy()!)}\r\n\r\n`))
        s.on('data', () => s.destroy())
        s.on('close', () => done())
      })
    }))
    expect(sites).toEqual(['blocked.example.net'])
  })
})

describe('offering a site', () => {
  it('skips what is listed (wildcards too) or already answered or offered, at most two', () => {
    markOffered('seen.com', 'owner:1')
    getDb().prepare("INSERT INTO egress_sites (host, status, updated_at) VALUES ('nope.com', 'declined', 0), ('back.com', 'removed', 0)").run()
    expect(sitesToOffer(['docs.example.org', 'irs.gov', 'seen.com', 'nope.com', '10.0.0.1', 'back.com', 'new.com', 'third.com'])).toEqual(['back.com', 'new.com'])
  })

  it('says what each button does, and gives a typed command where there are no buttons', () => {
    expect(buttonsFor('owner')).toEqual([ALLOW, DENY])
    expect(buttonsFor('operator')).toEqual([ASK, NOT_NEEDED])
    expect(offerText('example.com', 'owner', true)).toMatch(/Allow example\.com\?/)
    expect(offerText('example.com', 'owner', false)).toMatch(/\/egress allow example\.com/)
    expect(offerText('example.com', 'operator', true)).toMatch(/whoever looks after your assistant/)
    // Never a bug or a /support suggestion (card #305).
    for (const t of [offerText('a.com', 'owner', true), offerText('a.com', 'operator', false)]) expect(t).not.toMatch(/bug|\/support/i)
  })
})

describe('a tap on a site card', () => {
  const deps = (answer = 'ok') => {
    const calls: string[] = []
    return { calls, deps: { helper: async (r: string) => { calls.push(r); return answer }, ask: async (host: string) => `asked about ${host}` } }
  }

  it('Allow goes through the root helper, once', async () => {
    const d = deps()
    markOffered('example.com', 'owner:5')
    expect(await resolveSiteClick(true, 'owner:5', ALLOW, 'chat:owner', d.deps)).toMatch(/^Allowed example\.com/)
    expect(d.calls).toEqual(['allow example.com'])
    expect(await resolveSiteClick(true, 'owner:5', ALLOW, 'chat:owner', d.deps)).toBe('Already done.')
    expect(d.calls).toHaveLength(1)
  })

  it('says why when the helper refuses, and does not mark it allowed', async () => {
    const d = deps('no: sites on this box are approved by whoever runs it')
    markOffered('example.com', 'owner:5')
    expect(await resolveSiteClick(true, 'owner:5', ALLOW, 'chat:owner', d.deps)).toMatch(/could not add example\.com: sites on this box/)
    expect(sitesToOffer(['example.com'])).toEqual([])
  })

  it('never calls the helper when the box leaves approval to whoever runs it', async () => {
    h.live = { ...h.live, approver: 'operator' }
    const d = deps()
    markOffered('example.com', 'owner:5')
    expect(await resolveSiteClick(true, 'owner:5', ALLOW, 'chat:owner', d.deps)).toMatch(/added by whoever looks after it/)
    expect(d.calls).toEqual([])
  })

  it('Ask for access sends the request; Deny and Not needed are remembered', async () => {
    const d = deps()
    markOffered('a.com', 'owner:1')
    markOffered('b.com', 'owner:2')
    markOffered('c.com', 'owner:3')
    expect(await resolveSiteClick(true, 'owner:1', ASK, 'chat:owner', d.deps)).toBe('asked about a.com')
    expect(await resolveSiteClick(true, 'owner:2', DENY, 'chat:owner', d.deps)).toMatch(/won't ask about b\.com again/)
    expect(await resolveSiteClick(true, 'owner:3', NOT_NEEDED, 'chat:owner', d.deps)).toMatch(/c\.com/)
    expect(sitesToOffer(['a.com', 'b.com', 'c.com'])).toEqual([])
    expect(d.calls).toEqual([])
  })

  it('only in the main chat, and only on its own card', async () => {
    const d = deps()
    markOffered('example.com', 'owner:5')
    expect(await resolveSiteClick(false, 'owner:5', ALLOW, 'chat:other', d.deps)).toMatch(/main chat/)
    expect(await resolveSiteClick(true, 'owner:6', ALLOW, 'chat:owner', d.deps)).toBeNull()
    expect(await resolveSiteClick(true, 'owner:5', 'Send', 'chat:owner', d.deps)).toBeNull()
    expect(d.calls).toEqual([])
  })
})

describe('/egress', () => {
  const helper = (answer = 'ok') => {
    const calls: string[] = []
    return { calls, deps: { helper: async (r: string) => { calls.push(r); return answer }, ask: async () => '' } }
  }

  it('lists the sites, main chat only, and says when the list is off', async () => {
    const d = helper()
    expect(await egressCommand(true, true, '', 'chat:owner', d.deps)).toMatch(/- docs\.example\.org\n- \*\.gov/)
    expect(await egressCommand(false, true, 'list', 'chat:x', d.deps)).toMatch(/main chat/)
    expect(await egressCommand(true, false, 'list', 'chat:owner', d.deps)).toMatch(/off on this assistant/)
  })

  it('allow and remove take one plain name and go through the helper', async () => {
    const d = helper()
    expect(await egressCommand(true, true, 'allow Example.com', 'chat:owner', d.deps)).toMatch(/^Allowed example\.com/)
    expect(await egressCommand(true, true, 'remove example.com', 'chat:owner', d.deps)).toMatch(/^Took example\.com off/)
    expect(await egressCommand(true, true, 'allow *.evil.com', 'chat:owner', d.deps)).toMatch(/not a site name/)
    expect(await egressCommand(true, true, 'allow 169.254.169.254', 'chat:owner', d.deps)).toMatch(/not a site name/)
    expect(d.calls).toEqual(['allow example.com', 'remove example.com'])
    // A removed site may be offered again later.
    expect(sitesToOffer(['example.com'])).toEqual(['example.com'])
  })
})

describe('live settings', () => {
  it('reads the root-owned file again when it changes, so an approval needs no restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'egress-env-')), 'egress.env')
    writeFileSync(file, 'EGRESS=enforce\nEGRESS_READ=a.com\nEGRESS_APPROVER=owner\n')
    expect(liveEgressSettings(file)).toEqual({ allow: '', read: 'a.com', approver: 'owner' })
    writeFileSync(file, 'EGRESS=enforce\nEGRESS_READ=a.com,b.com\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(liveEgressSettings(file)).toEqual({ allow: '', read: 'a.com,b.com', approver: 'operator' })
  })
})
