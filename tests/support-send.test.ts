import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendSupportEmail, saveSupportRequest, type SendIO } from '../src/support/send.js'
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
