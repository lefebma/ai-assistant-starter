/**
 * Card #229: at-most-once effects. The journal itself, the commands the gate
 * reads, the gate, both send CLIs' send paths, the runtime env and the
 * at-most-once rule in the obligation checker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeMailbox, fakeSender } from './imap-fakes.js'

const STORE = mkdtempSync(join(tmpdir(), 'havn-effects-'))
process.env['AGENT_STORE_DIR'] = STORE
delete process.env['AGENT_RUN_KEY']

type Journal = typeof import('../src/assurance/effect-journal.js')
let j: Journal
let effectsOfCommand: typeof import('../src/assurance/effect-commands.js').effectsOfCommand
let gateToolCall: typeof import('../src/assurance/scope-gate.js').gateToolCall
let msSend: typeof import('../src/ms/mail.js').sendDraft
let imapSend: typeof import('../src/imap/mail.js').sendDraft
let draftMail: typeof import('../src/imap/mail.js').draftMail
let createRun: typeof import('../src/assurance/obligations.js').createRun
let createTools: typeof import('../src/runtime/ai-sdk/tools.js').createTools
let claimButtonClick: typeof import('../src/db.js').claimButtonClick

beforeAll(async () => {
  const db = await import('../src/db.js')
  db.initDatabase()
  claimButtonClick = db.claimButtonClick
  j = await import('../src/assurance/effect-journal.js')
  effectsOfCommand = (await import('../src/assurance/effect-commands.js')).effectsOfCommand
  gateToolCall = (await import('../src/assurance/scope-gate.js')).gateToolCall
  msSend = (await import('../src/ms/mail.js')).sendDraft
  const imap = await import('../src/imap/mail.js')
  imapSend = imap.sendDraft
  draftMail = imap.draftMail
  createRun = (await import('../src/assurance/obligations.js')).createRun
  createTools = (await import('../src/runtime/ai-sdk/tools.js')).createTools
})

afterAll(async () => {
  try {
    const { getDb } = await import('../src/db.js')
    getDb().close()
  } catch {
    // no handle to close
  }
  try {
    rmSync(STORE, { recursive: true, force: true })
  } catch {
    // the OS reaps its own temp directory
  }
})

const mail = (to: string[], subject = 'INV-3107 reminder') => ({ kind: 'email.send', target: j.emailTarget(to, subject), recipients: to })

describe('effect journal', () => {
  it('refuses the same effect twice in one run and counts the repeat', () => {
    const first = j.beginEffect(mail(['billing@a.example']), 'turn:r1')
    expect(first.ok).toBe(true)
    j.commitEffect(first.ok ? first.key : null)
    const again = j.beginEffect(mail(['Billing@A.example ']), 'turn:r1')
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(j.journalForRun('turn:r1')).toMatchObject([{ kind: 'email.send', status: 'done', repeats: 1 }])
  })

  it('a new run may send the same thing: the owner asking again is a new request', () => {
    expect(j.beginEffect(mail(['billing@a.example']), 'turn:r2').ok).toBe(true)
  })

  it('a different subject or recipient is a different effect', () => {
    expect(j.beginEffect(mail(['x@a.example'], 'one'), 'turn:r3').ok).toBe(true)
    expect(j.beginEffect(mail(['x@a.example'], 'two'), 'turn:r3').ok).toBe(true)
    expect(j.beginEffect(mail(['y@a.example'], 'one'), 'turn:r3').ok).toBe(true)
  })

  it('an unconfirmed attempt stays pending and is refused; a confirmed refusal frees the key', () => {
    const a = j.beginEffect(mail(['p@a.example']), 'turn:r4')
    expect(j.beginEffect(mail(['p@a.example']), 'turn:r4')).toMatchObject({ ok: false, reason: 'unconfirmed' })
    j.releaseEffect(a.ok ? a.key : null)
    expect(j.beginEffect(mail(['p@a.example']), 'turn:r4').ok).toBe(true)
  })

  it('releasing never clears an effect that went out', () => {
    const a = j.beginEffect(mail(['d@a.example']), 'turn:r5')
    const key = a.ok ? a.key : null
    j.commitEffect(key)
    j.releaseEffect(key)
    expect(j.beginEffect(mail(['d@a.example']), 'turn:r5').ok).toBe(false)
  })

  it('holds a per-run recipient limit outside the model', () => {
    const many = Array.from({ length: 10 }, (_, i) => `p${i}@a.example`)
    expect(j.beginEffect(mail(many.slice(0, 6), 'first'), 'turn:r6').ok).toBe(true)
    expect(j.beginEffect(mail(many.slice(6), 'second'), 'turn:r6').ok).toBe(true)
    const over = j.beginEffect(mail(['eleventh@a.example'], 'third'), 'turn:r6')
    expect(over).toMatchObject({ ok: false, reason: 'recipient-limit' })
    // Someone already reached does not count twice.
    expect(j.beginEffect(mail(['p0@a.example'], 'fourth'), 'turn:r6').ok).toBe(true)
  })

  it('no run means nothing to hold against: nothing is checked or written', () => {
    expect(j.beginEffect(mail(['z@a.example']))).toEqual({ ok: true, key: null })
    expect(j.beginEffect(mail(['z@a.example']))).toEqual({ ok: true, key: null })
  })

  it('run keys: a turn gets a fresh one, an outer run is kept, the env carries it', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2; i++) j.withRunOrNew('turn', () => seen.add(j.currentRun()!))
    expect(seen.size).toBe(2)
    j.withRun('card:c:m', () => j.withRunOrNew('turn', () => {
      expect(j.currentRun()).toBe('card:c:m')
      expect(j.runEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', AGENT_RUN_KEY: 'card:c:m' })
      expect(j.runEnvOption(undefined)).toMatchObject({ AGENT_RUN_KEY: 'card:c:m' })
    }))
    expect(j.runEnvOption(undefined)).toBeUndefined()
    expect(j.jobRunKey('t1', 100, true)).toBe('job:t1')
    expect(j.jobRunKey('t1', 100, false)).toBe('job:t1@100')
  })

  it('a child process reads the run from its env', () => {
    process.env.AGENT_RUN_KEY = 'job:from-parent'
    try {
      expect(j.currentRun()).toBe('job:from-parent')
    } finally {
      delete process.env.AGENT_RUN_KEY
    }
  })

  it('guardedEffect: commit on success, release only on a confirmed refusal', async () => {
    await j.guardedEffect(mail(['g@a.example']), async () => 'ok', 'turn:r7')
    await expect(j.guardedEffect(mail(['g@a.example']), async () => 'ok', 'turn:r7')).rejects.toThrow(/already went out/)
    await expect(j.guardedEffect(mail(['h@a.example']), async () => { throw j.markNotSent(new Error('550 rejected')) }, 'turn:r7')).rejects.toThrow(/550/)
    await expect(j.guardedEffect(mail(['h@a.example']), async () => 'ok', 'turn:r7')).resolves.toBe('ok')
    await expect(j.guardedEffect(mail(['i@a.example']), async () => { throw new Error('socket hang up') }, 'turn:r7')).rejects.toThrow(/hang up/)
    await expect(j.guardedEffect(mail(['i@a.example']), async () => 'ok', 'turn:r7')).rejects.toThrow(/may have gone out/)
  })
})

describe('commands the gate keys from the outside', () => {
  it('gog gmail send: recipients and subject, quotes resolved', () => {
    const [e] = effectsOfCommand(`gog gmail send --to "B@x.example,a@x.example" --bcc c@x.example --subject 'Your  invoice' --body "Hi; see attached" --account me@x.example`)
    expect(e).toEqual({ kind: 'email.send', target: 'a@x.example,b@x.example,c@x.example|your invoice', recipients: ['a@x.example', 'b@x.example', 'c@x.example'] })
  })

  it('a saved Gmail draft is keyed by its id', () => {
    expect(effectsOfCommand('gog gmail drafts send r-123 --account me@x.example')).toEqual([{ kind: 'email.send', target: 'gmail-draft:r-123' }])
  })

  it('slack post and dm, also through python3 and a path', () => {
    const [post] = effectsOfCommand('python3 skills/slack/scripts/slack.py post --channel C01 --text "Shipped"')
    expect(post).toMatchObject({ kind: 'slack.post' })
    expect(post.target.startsWith('c01|')).toBe(true)
    const [dm] = effectsOfCommand('skills/slack/scripts/slack.py dm --user U9 --text hi')
    expect(dm).toMatchObject({ kind: 'slack.dm', recipients: ['U9'] })
  })

  it('reads every send in a chained command, and nothing else', () => {
    expect(effectsOfCommand('gog gmail search "is:unread" && gog gmail drafts list')).toEqual([])
    expect(effectsOfCommand('gog gmail send --to a@x.example --subject s; slack.py post --channel C --text t')).toHaveLength(2)
  })
})

describe('the gate', () => {
  const call = (command: string) => ({ session: 's', tool: 'Bash', input: { command }, cwd: STORE })

  it('refuses a second identical send in the same run, not in another', () => {
    const send = 'gog gmail send --to a@x.example --subject "Gate test" --body hi'
    j.withRun('turn:g1', () => {
      expect(gateToolCall(call(send)).allow).toBe(true)
      const second = gateToolCall(call(send))
      expect(second.allow).toBe(false)
      expect(!second.allow && second.reason).toMatch(/already went out in this run/)
      expect(gateToolCall(call('gog gmail search "x"')).allow).toBe(true)
    })
    j.withRun('turn:g2', () => expect(gateToolCall(call(send)).allow).toBe(true))
  })

  it('a refused call claims nothing for its other sends', () => {
    j.withRun('turn:g3', () => {
      expect(gateToolCall(call('slack.py post --channel C --text one')).allow).toBe(true)
      expect(gateToolCall(call('slack.py post --channel C --text two; slack.py post --channel C --text one')).allow).toBe(false)
      expect(gateToolCall(call('slack.py post --channel C --text two')).allow).toBe(true)
    })
  })

  it('outside any run the gate does not hold sends', () => {
    const send = 'gog gmail send --to a@x.example --subject "No run" --body hi'
    expect(gateToolCall(call(send)).allow).toBe(true)
    expect(gateToolCall(call(send)).allow).toBe(true)
  })
})

describe('Outlook send under a run', () => {
  function graph(fail?: Error) {
    const calls: string[] = []
    return {
      calls,
      client: {
        get: async (path: string) => {
          calls.push(`GET ${path}`)
          return { subject: 'Re: invoice', toRecipients: [{ emailAddress: { address: 'billing@a.example' } }], bccRecipients: [{ emailAddress: { address: 'cfo@a.example' } }] }
        },
        post: async (path: string) => {
          calls.push(`POST ${path}`)
          if (fail) throw fail
          return {}
        },
        patch: async () => ({}),
      },
    }
  }

  it('reads the draft envelope, sends once, refuses a redraft of the same email', async () => {
    await j.withRun('turn:ms1', async () => {
      const g = graph()
      await msSend(g.client, 'D1', true)
      expect(g.calls).toEqual(['GET /me/messages/D1?$select=subject,toRecipients,ccRecipients,bccRecipients', 'POST /me/messages/D1/send'])
      const g2 = graph()
      await expect(msSend(g2.client, 'D2', true)).rejects.toThrow(/already went out/)
      expect(g2.calls.some((c) => c.startsWith('POST'))).toBe(false)
    })
    expect(j.journalForRun('turn:ms1')[0]).toMatchObject({ recipients: JSON.stringify(['billing@a.example', 'cfo@a.example']) })
  })

  it('a Graph 4xx frees the key; a timeout does not', async () => {
    const { markNotSent } = j
    await j.withRun('turn:ms2', async () => {
      await expect(msSend(graph(markNotSent(new Error('Graph 400: bad'))).client, 'D1', true)).rejects.toThrow(/400/)
      await msSend(graph().client, 'D1', true)
    })
    await j.withRun('turn:ms3', async () => {
      await expect(msSend(graph(new Error('The operation was aborted due to timeout')).client, 'D1', true)).rejects.toThrow(/timeout/)
      await expect(msSend(graph().client, 'D1', true)).rejects.toThrow(/may have gone out/)
    })
  })
})

describe('IMAP send under a run', () => {
  it('the same email redrafted in one run goes out once', async () => {
    const box = fakeMailbox()
    const s = fakeSender()
    await j.withRun('turn:imap1', async () => {
      const d1 = await draftMail(box, { from: 'me@x.example', to: ['bob@x.example'], subject: 'Invoice', body: 'hi' })
      await imapSend(box, s, 'me@x.example', d1.id!, true, true)
      const d2 = await draftMail(box, { from: 'me@x.example', to: ['bob@x.example'], subject: 'Invoice', body: 'hi again' })
      await expect(imapSend(box, s, 'me@x.example', d2.id!, true, true)).rejects.toThrow(/already went out/)
    })
    expect(s.sent.map((m) => m.envelope.to)).toEqual([['bob@x.example']])
  })
})

describe('the ai-sdk bash tool carries the run key', () => {
  it('a command sees AGENT_RUN_KEY inside a run', async () => {
    const tools = createTools(STORE)
    const out = await j.withRun('turn:sdk1', () => (tools.bash as { execute: (a: unknown, o: unknown) => Promise<string> }).execute({ command: 'node -e "console.log(process.env.AGENT_RUN_KEY)"' }, {}))
    expect(out.trim()).toBe('turn:sdk1')
  })
})

describe('at-most-once in the obligation checker', () => {
  const obligations = [{ id: 'reminder', description: 'reminder sent', evidenceType: 'email.sent' }]
  const ev = (eventId: string) => ({ eventId, runId: 'r', origin: 'tool' as const, evidenceType: 'email.sent', obligationId: 'reminder' })

  it('a second distinct send for a one-send obligation is not completion', () => {
    const { authority } = createRun('r', obligations)
    expect(authority.record(ev('fx-1'))).toEqual({ accepted: true })
    expect(authority.requestCompletion().status).toBe('complete')
    expect(authority.record(ev('fx-2'))).toEqual({ accepted: false, reason: 'over-limit' })
    expect(authority.requestCompletion()).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/twice/) })
  })

  it('maxCount allows a declared number of sends', () => {
    const { authority } = createRun('r', [{ ...obligations[0], minCount: 1, maxCount: 2 }])
    authority.record(ev('fx-1'))
    authority.record(ev('fx-2'))
    expect(authority.requestCompletion().status).toBe('complete')
  })
})

describe('approval cards', () => {
  it('a claim is kept past 7 days, so an old card cannot send again', () => {
    const realNow = Date.now
    try {
      Date.now = () => new Date('2026-10-01T12:00:00Z').getTime()
      expect(claimButtonClick('chat-x', 'card-old', 'Send').claimed).toBe(true)
      Date.now = () => new Date('2026-12-01T12:00:00Z').getTime()
      expect(claimButtonClick('chat-x', 'card-new', 'Send').claimed).toBe(true)
      expect(claimButtonClick('chat-x', 'card-old', 'Send')).toEqual({ claimed: false, existingLabel: 'Send' })
    } finally {
      Date.now = realNow
    }
  })
})
