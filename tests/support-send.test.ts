import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sendSupportEmail,
  saveSupportRequest,
  resolveGmailAccount,
  type SendIO,
} from '../src/support/send.js'
import type { SupportDraft } from '../src/support/draft.js'

const draft: SupportDraft = {
  to: 'support@els-partners.com',
  subject: 'Support request: AI Assistant v1.15.0',
  body: 'It broke.\n\n--- Diagnostics (auto-collected, redacted) ---\nApp version: 1.15.0\n',
}

describe('sendSupportEmail', () => {
  it('sends through gog gmail send with argv (no shell), addressed from the draft', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const io: SendIO = {
      exec: async (cmd, args) => {
        calls.push({ cmd, args })
        return { code: 0, out: 'sent' }
      },
    }

    const res = await sendSupportEmail(draft, io)
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args.slice(0, 2)).toEqual(['gmail', 'send'])
    expect(calls[0].args).toContain('--to')
    expect(calls[0].args[calls[0].args.indexOf('--to') + 1]).toBe(draft.to)
    expect(calls[0].args[calls[0].args.indexOf('--subject') + 1]).toBe(draft.subject)
    expect(calls[0].args[calls[0].args.indexOf('--body') + 1]).toBe(draft.body)
  })

  it('reports failure detail when gog exits non-zero (e.g. no account connected)', async () => {
    const io: SendIO = {
      exec: async () => ({ code: 1, out: 'no authenticated account' }),
    }
    const res = await sendSupportEmail(draft, io)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('no authenticated account')
  })

  it('reports failure when the binary is missing rather than throwing', async () => {
    const io: SendIO = {
      exec: async () => {
        throw new Error('spawn gog ENOENT')
      },
    }
    const res = await sendSupportEmail(draft, io)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('ENOENT')
  })

  it('passes --account explicitly when the resolver finds one, ahead of --to', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const io: SendIO = {
      exec: async (cmd, args) => {
        calls.push({ cmd, args })
        return { code: 0, out: 'sent' }
      },
    }

    await sendSupportEmail(draft, io, () => 'owner@gmail.com')
    const args = calls[0].args
    expect(args).toContain('--account')
    expect(args[args.indexOf('--account') + 1]).toBe('owner@gmail.com')
    expect(args.indexOf('--account')).toBeLessThan(args.indexOf('--to'))
  })

  it('omits --account when the resolver finds nothing, unchanged from before', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const io: SendIO = {
      exec: async (cmd, args) => {
        calls.push({ cmd, args })
        return { code: 0, out: 'sent' }
      },
    }

    await sendSupportEmail(draft, io, () => undefined)
    expect(calls[0].args).not.toContain('--account')
  })
})

describe('resolveGmailAccount', () => {
  it('reads the Account line out of the deployed gmail skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-account-'))
    try {
      mkdirSync(join(dir, 'skills', 'gmail'), { recursive: true })
      writeFileSync(
        join(dir, 'skills', 'gmail', 'SKILL.md'),
        '## Gmail & Google Calendar\n\nAccount: marina@swaysales.org\nCLI: `gog`\n'
      )
      expect(resolveGmailAccount(dir)).toBe('marina@swaysales.org')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a hand-edited "Default account:" line too (multi-account box)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-account-'))
    try {
      mkdirSync(join(dir, 'skills', 'gmail'), { recursive: true })
      writeFileSync(
        join(dir, 'skills', 'gmail', 'SKILL.md'),
        '## Gmail & Google Calendar\n\nDefault account: marina@aimmalliance.com\nCLI: `gog`\n'
      )
      expect(resolveGmailAccount(dir)).toBe('marina@aimmalliance.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined when the gmail skill is not deployed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmail-account-'))
    try {
      expect(resolveGmailAccount(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('saveSupportRequest', () => {
  it('writes the request to a local file and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'support-req-'))
    try {
      const path = saveSupportRequest(draft, dir)
      expect(path.startsWith(dir)).toBe(true)
      const content = readFileSync(path, 'utf-8')
      expect(content).toContain(`To: ${draft.to}`)
      expect(content).toContain(`Subject: ${draft.subject}`)
      expect(content).toContain('It broke.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
