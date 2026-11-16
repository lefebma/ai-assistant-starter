/**
 * /request (card #240): the draft, the tidy, the per-box limit and the
 * Send / Edit / Cancel flow, with no platform and no real email.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRequestDraft,
  formatRequestPreview,
  newRequestRef,
  parseTidied,
  tidyPrompt,
  MAX_REQUEST_CHARS,
  type RequestDraft,
} from '../src/request/draft.js'
import { MAX_REQUESTS_PER_DAY, recordRequest, requestsInLastDay } from '../src/request/store.js'
import { RequestFlow, REQUEST_BUTTONS, type RequestFlowDeps } from '../src/request/flow.js'
import { ensureRequestSection } from '../src/update/conventions.js'

const SENDER = { ownerName: 'Sam', boxName: 'sam.gethavn.ai', version: '1.80.0' }
const TIDIED = 'What: Track my mileage from calendar trips\nWhy: For my tax claim\nHow often: Weekly'

describe('request draft', () => {
  it('makes a readable reference with no look-alike characters', () => {
    const ref = newRequestRef(() => Buffer.from([0, 1, 2, 255]))
    expect(ref).toMatch(/^REQ-[A-HJKMNP-Z2-9]{4}$/)
    for (let i = 0; i < 50; i++) expect(newRequestRef()).not.toMatch(/[01IOL]/)
  })

  it('keeps the three tidied lines and nothing else', () => {
    const out = `Sure, here it is:\n${TIDIED}\nLet me know if you need more.`
    expect(parseTidied(out, 'raw')).toBe(TIDIED)
  })

  it('fills a missing line with Not said', () => {
    expect(parseTidied('What: A weekly invoice summary', 'raw')).toBe('What: A weekly invoice summary\nWhy: Not said\nHow often: Not said')
  })

  it('falls back to the customer\'s own words when the answer has no What line', () => {
    expect(parseTidied('I cannot help with that.', '  track mileage  ')).toBe('What: track mileage')
    expect(parseTidied('', 'track mileage')).toBe('What: track mileage')
  })

  it('puts the request inside the prompt and asks for no additions', () => {
    const p = tidyPrompt('track mileage')
    expect(p).toContain('<request>\ntrack mileage\n</request>')
    expect(p).toContain('Use only what they said')
  })

  it('sends the request with the name, the box and the version only', () => {
    const d = buildRequestDraft(TIDIED, SENDER, 'support@example.com', 'REQ-ABCD')
    expect(d.to).toBe('support@example.com')
    expect(d.subject).toBe('Feature request REQ-ABCD: Track my mileage from calendar trips')
    expect(d.body).toContain(TIDIED)
    expect(d.body).toContain('Customer: Sam')
    expect(d.body).toContain('Assistant: sam.gethavn.ai')
    expect(d.body).toContain('Version: 1.80.0')
    expect(d.body).not.toMatch(/Diagnostics|skills|log/i)
  })

  it('keeps a long subject to one short line', () => {
    const d = buildRequestDraft(`What: ${'very '.repeat(40)}long\nWhy: x\nHow often: y`, SENDER, 'a@b.c', 'REQ-ABCD')
    expect(d.subject.length).toBeLessThanOrEqual('Feature request REQ-ABCD: '.length + 60)
    expect(d.subject).not.toContain('\n')
  })

  it('shows the customer what goes with it before anything is sent', () => {
    const d = buildRequestDraft(TIDIED, SENDER, 'a@b.c', 'REQ-ABCD')
    const p = formatRequestPreview(d, SENDER)
    expect(p).toContain(TIDIED)
    expect(p).toContain('your name (Sam)')
    expect(p).toContain('Nothing has been sent yet.')
  })
})

describe('request limit', () => {
  it('counts only the last 24 hours and drops older entries', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'req-limit-')), 'feature-requests.json')
    const t0 = new Date('2026-11-16T10:00:00Z')
    recordRequest(file, 'REQ-AAAA', t0)
    recordRequest(file, 'REQ-BBBB', new Date(t0.getTime() + 60_000))
    expect(requestsInLastDay(file, new Date(t0.getTime() + 120_000))).toBe(2)
    const later = new Date(t0.getTime() + 25 * 3600_000)
    expect(requestsInLastDay(file, later)).toBe(0)
    recordRequest(file, 'REQ-CCCC', later)
    const kept = JSON.parse(readFileSync(file, 'utf-8'))
    expect(kept.map((e: { ref: string }) => e.ref)).toEqual(['REQ-CCCC'])
    // Only the reference and the time, never the words.
    expect(Object.keys(kept[0]).sort()).toEqual(['at', 'ref'])
  })

  it('reads a missing or broken log as empty', () => {
    expect(requestsInLastDay(join(tmpdir(), 'no-such-dir-xyz', 'f.json'))).toBe(0)
  })
})

describe('RequestFlow', () => {
  let dir: string
  let sent: RequestDraft[]
  let tidyCalls: string[]
  let sendResult: { ok: boolean; detail: string }
  let tidy: (raw: string) => Promise<string>
  let refs: number

  const deps = (): RequestFlowDeps => ({
    tidy: (raw) => {
      tidyCalls.push(raw)
      return tidy(raw)
    },
    send: async (d) => {
      sent.push(d)
      return sendResult
    },
    sender: () => SENDER,
    to: () => 'support@example.com',
    logFile: join(dir, 'store', 'feature-requests.json'),
    saveDir: join(dir, 'feature-requests'),
    newRef: () => `REQ-000${++refs}`,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'req-flow-'))
    sent = []
    tidyCalls = []
    refs = 0
    sendResult = { ok: true, detail: '' }
    tidy = async () => TIDIED
  })

  it('tidies the words, shows the draft with Send / Edit / Cancel, and sends only on Send', async () => {
    const flow = new RequestFlow(deps())
    const r = await flow.command('c1', '/request track my mileage for taxes, weekly')
    expect(tidyCalls).toEqual(['track my mileage for taxes, weekly'])
    expect(r.text).toContain(TIDIED)
    expect(r.buttons).toEqual(REQUEST_BUTTONS)
    expect(sent).toHaveLength(0)
    const done = await flow.resolve('c1', 'Send')
    expect(done!.text).toBe('Sent. The Havn team will see it. Your reference is REQ-0001.')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toContain('REQ-0001')
    expect(flow.hasDraft('c1')).toBe(false)
    // The card takes one answer.
    expect(await flow.resolve('c1', 'Send')).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('asks first on a bare /request and takes the next message', async () => {
    const flow = new RequestFlow(deps())
    const ask = await flow.command('c1', '/request')
    expect(ask.text).toContain('What would you like your assistant to do')
    expect(flow.owns('c1', 'a mileage log')).toBe(true)
    expect(flow.owns('c1', '/help')).toBe(false)
    const r = await flow.answer('c1', 'a mileage log')
    expect(r.buttons).toEqual(REQUEST_BUTTONS)
    expect(flow.isAwaiting('c1')).toBe(false)
  })

  it('accepts /request@botname from a Telegram group menu', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request@HavnBot a mileage log')
    expect(tidyCalls).toEqual(['a mileage log'])
  })

  it('uses the words as written when the tidy fails', async () => {
    tidy = async () => {
      throw new Error('model down')
    }
    const flow = new RequestFlow(deps())
    const r = await flow.command('c1', '/request a mileage log')
    expect(r.text).toContain('What: a mileage log')
  })

  it('Edit takes the next message as written, without another tidy', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request a mileage log')
    const e = await flow.resolve('c1', 'Edit')
    expect(e!.text).toContain('next message')
    const r = await flow.answer('c1', 'A mileage log from my calendar, weekly, for taxes')
    expect(tidyCalls).toHaveLength(1)
    expect(r.text).toContain('A mileage log from my calendar, weekly, for taxes')
    await flow.resolve('c1', 'send')
    expect(sent[0]!.body).toContain('A mileage log from my calendar, weekly, for taxes')
  })

  it('Cancel sends nothing', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request a mileage log')
    expect((await flow.resolve('c1', 'Cancel'))!.text).toBe('Cancelled. Nothing was sent.')
    expect(sent).toHaveLength(0)
    expect(flow.hasDraft('c1')).toBe(false)
  })

  it('ignores other words on a pending draft', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request a mileage log')
    expect(await flow.resolve('c1', 'Discard')).toBeNull()
    expect(flow.owns('c1', 'what time is it')).toBe(false)
    expect(flow.hasDraft('c1')).toBe(true)
  })

  it('keeps chats apart', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request a mileage log')
    expect(await flow.resolve('c2', 'Send')).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('refuses a request over the length limit and waits for a shorter one', async () => {
    const flow = new RequestFlow(deps())
    const r = await flow.command('c1', `/request ${'x'.repeat(MAX_REQUEST_CHARS + 1)}`)
    expect(r.text).toContain(`under ${MAX_REQUEST_CHARS}`)
    expect(tidyCalls).toHaveLength(0)
    expect(flow.isAwaiting('c1')).toBe(true)
  })

  it(`stops after ${MAX_REQUESTS_PER_DAY} requests a day`, async () => {
    const flow = new RequestFlow(deps())
    for (let i = 0; i < MAX_REQUESTS_PER_DAY; i++) {
      await flow.command('c1', `/request idea ${i}`)
      await flow.resolve('c1', 'Send')
    }
    expect(sent).toHaveLength(MAX_REQUESTS_PER_DAY)
    const r = await flow.command('c1', '/request one more')
    expect(r.text).toContain('limit')
    expect(tidyCalls).toHaveLength(MAX_REQUESTS_PER_DAY)
  })

  it('checks the limit again at Send, so drafts made earlier cannot pile through', async () => {
    const flow = new RequestFlow(deps())
    await flow.command('c2', '/request held draft')
    for (let i = 0; i < MAX_REQUESTS_PER_DAY; i++) {
      await flow.command('c1', `/request idea ${i}`)
      await flow.resolve('c1', 'Send')
    }
    const r = await flow.resolve('c2', 'Send')
    expect(r!.text).toContain('limit')
    expect(sent).toHaveLength(MAX_REQUESTS_PER_DAY)
  })

  it('saves the request on the box when the email cannot go out', async () => {
    sendResult = { ok: false, detail: 'no Gmail account' }
    const flow = new RequestFlow(deps())
    await flow.command('c1', '/request a mileage log')
    const r = await flow.resolve('c1', 'Send')
    expect(r!.text).toContain('no Gmail account')
    expect(r!.text).toContain('REQ-0001')
    const file = join(dir, 'feature-requests', 'REQ-0001.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toContain('Subject: Feature request REQ-0001')
    // A saved request still counts toward the limit.
    expect(requestsInLastDay(join(dir, 'store', 'feature-requests.json'))).toBe(1)
  })
})

describe('CLAUDE.md /request hint for existing installs', () => {
  it('appends once, and leaves a file that already mentions /request alone', () => {
    const once = ensureRequestSection('# Assistant\n\nSome rules.\n')
    expect(once).toContain('## Asking for a feature')
    expect(once).toContain('`/request`')
    expect(ensureRequestSection(once!)).toBeNull()
    expect(ensureRequestSection('Use /request for wishes.')).toBeNull()
  })
})
