/**
 * tests/outbound-delivery.test.ts
 *
 * A reply that carries a file, sent by something other than a person's turn.
 *
 * The marker handling started inside bot.ts, which quietly made it
 * interactive-only: the scheduler sends task output straight through
 * adapter.sendMessage, so a [[file:]] in a scheduled reply arrived in the
 * chat as the literal text `[[file: workspace/uploads/chart.png]]`. The jobs
 * most likely to produce a file (a briefing with a chart, a monthly audit as
 * a PDF) are the ones with nobody there to ask for it, so this is the path
 * that has to work unattended.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/assistant-vitest-outbound-delivery`
  process.env.AGENT_STORE_DIR = dir
  return dir
})
rmSync(STORE, { recursive: true, force: true })

import { deliverFiles, sendTextWithFiles } from '../src/outbound-delivery.js'
import { UPLOADS_DIR } from '../src/media.js'
import type { PlatformAdapter } from '../src/platform/types.js'

type Call = { kind: 'message'; text: string } | { kind: 'file'; path: string; type: string }

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}): { adapter: PlatformAdapter; calls: Call[] } {
  const calls: Call[] = []
  const adapter = {
    name: 'fake',
    maxMessageLength: 4000,
    supportsEdit: false,
    supportsButtons: false,
    start: async () => {},
    stop: async () => {},
    sendMessage: async (_chatId: string, text: string) => {
      calls.push({ kind: 'message', text })
      return 'id-1'
    },
    editMessage: async () => {},
    sendTyping: async () => {},
    sendFile: async (_chatId: string, path: string, type: string) => {
      calls.push({ kind: 'file', path, type })
    },
    answerCallback: async () => {},
    clearButtons: async () => {},
    formatText: (markdown: string) => markdown,
    splitMessage: (text: string) => (text ? [text] : []),
    onMessage: () => {},
    onActivity: () => {},
    ...overrides,
  } as unknown as PlatformAdapter
  return { adapter, calls }
}

const NAME = 'delivery-test-chart.png'
const target = join(UPLOADS_DIR, NAME)

beforeEach(() => {
  mkdirSync(UPLOADS_DIR, { recursive: true })
  writeFileSync(target, Buffer.from('not really a png, but it is a file'))
})

afterEach(() => {
  if (existsSync(target)) rmSync(target)
})

describe('a scheduled reply that carries a file', () => {
  it('sends the text without the marker, then the file', async () => {
    const { adapter, calls } = fakeAdapter()
    await sendTextWithFiles(adapter, 'chat-1', `Morning briefing: one chart.\n\n[[file: workspace/uploads/${NAME}]]`)
    expect(calls).toEqual([
      { kind: 'message', text: 'Morning briefing: one chart.' },
      { kind: 'file', path: target, type: 'photo' },
    ])
  })

  it('leaves a reply with no marker exactly as it was', async () => {
    const { adapter, calls } = fakeAdapter()
    await sendTextWithFiles(adapter, 'chat-1', 'Nothing to attach today.')
    expect(calls).toEqual([{ kind: 'message', text: 'Nothing to attach today.' }])
  })

  it('still sends the text when the file is refused, and says why', async () => {
    const { adapter, calls } = fakeAdapter()
    await sendTextWithFiles(adapter, 'chat-1', 'Here is the audit.\n\n[[file: .env]]')
    expect(calls[0]).toEqual({ kind: 'message', text: 'Here is the audit.' })
    expect(calls[1]).toMatchObject({ kind: 'message' })
    expect(calls.some((c) => c.kind === 'file')).toBe(false)
    const refusal = calls[1] as { text: string }
    expect(refusal.text).toContain('could not send .env')
  })

  it('falls back to an unformatted send when the platform rejects the markup', async () => {
    let first = true
    const { adapter, calls } = fakeAdapter({
      sendMessage: async (_chatId: string, text: string) => {
        if (first) {
          first = false
          throw new Error('bad markup')
        }
        calls.push({ kind: 'message', text })
        return 'id'
      },
    })
    await sendTextWithFiles(adapter, 'chat-1', 'Plain please.')
    expect(calls).toEqual([{ kind: 'message', text: 'Plain please.' }])
  })
})

describe('a reply that is nothing but a marker', () => {
  it('sends no empty message, and still delivers the file', async () => {
    // The live failure on havn-test: the assistant answered "send me the
    // note" with the marker alone, stripping it left an empty string, and
    // Teams answered 400 BadSyntax ("Activity must include non empty 'text'
    // field or at least 1 attachment"). The throw landed before the file was
    // sent, so the chat got nothing at all.
    const { adapter, calls } = fakeAdapter()
    await sendTextWithFiles(adapter, 'chat-1', `[[file: workspace/uploads/${NAME}]]`)
    expect(calls).toEqual([{ kind: 'file', path: target, type: 'photo' }])
  })

  it('delivers the file even when the platform rejects the text', async () => {
    const { adapter, calls } = fakeAdapter({
      sendMessage: async () => {
        throw new Error('platform rejected the text')
      },
    })
    await sendTextWithFiles(adapter, 'chat-1', `Here it is.\n\n[[file: workspace/uploads/${NAME}]]`)
    expect(calls).toEqual([{ kind: 'file', path: target, type: 'photo' }])
  })

  it('still throws when the text fails and there was no file to save', async () => {
    const { adapter } = fakeAdapter({
      sendMessage: async () => {
        throw new Error('platform rejected the text')
      },
    })
    await expect(sendTextWithFiles(adapter, 'chat-1', 'Just words.')).rejects.toThrow('platform rejected the text')
  })
})

describe('deliverFiles on its own', () => {
  it('reports a send that throws, and names where the file still is', async () => {
    const { adapter, calls } = fakeAdapter({
      sendFile: async () => {
        throw new Error('platform said no')
      },
    })
    await deliverFiles(adapter, 'chat-1', [{ requested: `workspace/uploads/${NAME}` }])
    const message = calls.find((c) => c.kind === 'message') as { text: string }
    expect(message.text).toContain(NAME)
    expect(message.text).toContain(target)
  })

  it('keeps going after one file is refused', async () => {
    const { adapter, calls } = fakeAdapter()
    await deliverFiles(adapter, 'chat-1', [
      { requested: 'workspace/uploads/does-not-exist.pdf' },
      { requested: `workspace/uploads/${NAME}` },
    ])
    expect(calls.filter((c) => c.kind === 'message')).toHaveLength(1)
    expect(calls.filter((c) => c.kind === 'file')).toEqual([{ kind: 'file', path: target, type: 'photo' }])
  })
})
