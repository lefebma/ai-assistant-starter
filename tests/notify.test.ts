import { describe, it, expect, vi } from 'vitest'
import { sendTelegram } from '../src/notify.js'

describe('sendTelegram', () => {
  it('posts the message to the Telegram API', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as never
    const ok = await sendTelegram('hello there', { token: 'tok123', chatId: '42', fetchImpl })
    expect(ok).toBe(true)
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bottok123/sendMessage')
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: '42', text: 'hello there' })
  })

  it('returns false when config is missing, without calling the API', async () => {
    const fetchImpl = vi.fn() as never
    expect(await sendTelegram('x', { token: '', chatId: '42', fetchImpl })).toBe(false)
    expect(await sendTelegram('x', { token: 't', chatId: '', fetchImpl })).toBe(false)
    expect((fetchImpl as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('returns false on API failure instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 })) as never
    expect(await sendTelegram('x', { token: 't', chatId: 'c', fetchImpl })).toBe(false)
    const boom = vi.fn(async () => { throw new Error('network down') }) as never
    expect(await sendTelegram('x', { token: 't', chatId: 'c', fetchImpl: boom })).toBe(false)
  })
})
