/**
 * tests/telegram-reply-context.test.ts
 * Mapping of Telegram reply_to_message / quote / forward_origin onto the
 * neutral ReplyContext the bot folds into the prompt.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/db.js', () => ({ hasProcessedUpdate: vi.fn(), markUpdateProcessed: vi.fn() }))
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { telegramReplyContext } from '../src/platform/telegram.js'

const BOT = 42

describe('telegramReplyContext', () => {
  it('returns undefined for a plain message', () => {
    expect(telegramReplyContext({}, BOT)).toBeUndefined()
    expect(telegramReplyContext({ reply_to_message: { from: { id: 7 } } }, BOT)).toBeUndefined()
  })

  it('marks a reply to the bot as fromSelf without a name', () => {
    expect(telegramReplyContext({ reply_to_message: { from: { id: BOT, first_name: 'Bot' }, text: 'earlier' } }, BOT))
      .toEqual({ replyTo: { text: 'earlier', fromSelf: true } })
  })

  it('carries the sender first name for a reply to a person', () => {
    expect(telegramReplyContext({ reply_to_message: { from: { id: 7, first_name: 'Marc' }, text: 'orig' } }, BOT))
      .toEqual({ replyTo: { text: 'orig', fromSelf: false, fromName: 'Marc' } })
  })

  it('prefers the highlighted quote excerpt over the full replied text', () => {
    const out = telegramReplyContext({ reply_to_message: { from: { id: 7 }, text: 'full long message' }, quote: { text: 'long' } }, BOT)
    expect(out?.replyTo?.text).toBe('long')
  })

  it('falls back to the caption when the replied message is media', () => {
    expect(telegramReplyContext({ reply_to_message: { from: { id: 7 }, caption: 'photo caption' } }, BOT)?.replyTo?.text).toBe('photo caption')
  })

  it('names the forward origin for each origin type', () => {
    expect(telegramReplyContext({ forward_origin: { type: 'user', sender_user: { first_name: 'Ana' } } })?.forwardedFrom).toBe('Ana')
    expect(telegramReplyContext({ forward_origin: { type: 'hidden_user', sender_user_name: 'Ghost' } })?.forwardedFrom).toBe('Ghost')
    expect(telegramReplyContext({ forward_origin: { type: 'chat', sender_chat: { title: 'Dojo' } } })?.forwardedFrom).toBe('Dojo')
    expect(telegramReplyContext({ forward_origin: { type: 'channel', chat: { title: 'News' } } })?.forwardedFrom).toBe('News')
  })
})
