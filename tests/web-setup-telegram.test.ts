import { describe, it, expect } from 'vitest'
import { checkBotToken, Pairing, PAIR_WINDOW_MS } from '../src/setup/web/telegram.js'
import { BOT_TOKEN, fakeTelegram } from './web-setup-fakes.js'

const T0 = 1_760_000_000_000

describe('checkBotToken', () => {
  it('returns the bot username for a good token', async () => {
    const tg = fakeTelegram()
    expect(await checkBotToken(tg.f, BOT_TOKEN)).toEqual({ username: 'avery_test_bot', firstName: 'Avery' })
  })

  it('rejects something that is not shaped like a token without calling Telegram', async () => {
    const tg = fakeTelegram()
    await expect(checkBotToken(tg.f, 'hello')).rejects.toThrow(/does not look like a bot token/)
    expect(tg.calls).toEqual([])
  })

  it('explains a token Telegram refuses', async () => {
    await expect(checkBotToken(fakeTelegram({ badToken: true }).f, BOT_TOKEN)).rejects.toThrow(/did not accept that token/)
  })
})

describe('Pairing', () => {
  function pairing(now = { t: T0 }) {
    const tg = fakeTelegram()
    const p = new Pairing(tg.f, BOT_TOKEN, () => now.t, 0)
    return { tg, p, now }
  }

  it('pairs on a private /start sent after it started waiting', async () => {
    const { tg, p } = pairing()
    await p.step()
    tg.push({ chatId: 42, date: T0 / 1000 + 5, first: 'Leif', username: 'leifb' })
    await p.step()
    expect(p.state).toEqual({ kind: 'found', candidate: { chatId: 42, name: 'Leif', username: 'leifb' } })
    await p.confirm(true)
    expect(p.state.kind).toBe('paired')
  })

  it('accepts the deep-link form /start setup', async () => {
    const { tg, p } = pairing()
    await p.step()
    tg.push({ chatId: 42, date: T0 / 1000 + 5, text: '/start setup' })
    await p.step()
    expect(p.state.kind).toBe('found')
  })

  it('ignores a /start that was already waiting on the bot', async () => {
    const { tg, p } = pairing()
    tg.push({ chatId: 66, date: T0 / 1000 + 1 })
    await p.step()
    await p.step()
    expect(p.state.kind).toBe('waiting')
  })

  it('ignores groups, other text, and messages older than the wait', async () => {
    const { tg, p } = pairing()
    await p.step()
    tg.push({ chatId: -100, type: 'group', date: T0 / 1000 + 5 })
    tg.push({ chatId: 7, text: 'hello', date: T0 / 1000 + 5 })
    tg.push({ chatId: 8, date: T0 / 1000 - 60 })
    await p.step()
    expect(p.state.kind).toBe('waiting')
  })

  it('"not me" ignores that chat and keeps waiting for someone else', async () => {
    const { tg, p } = pairing()
    p.stop()
    await p.step()
    tg.push({ chatId: 13, date: T0 / 1000 + 5, first: 'Stranger' })
    await p.step()
    await p.confirm(false)
    expect(p.state.kind).toBe('waiting')
    tg.push({ chatId: 13, date: T0 / 1000 + 6, first: 'Stranger' })
    tg.push({ chatId: 42, date: T0 / 1000 + 7, first: 'Leif' })
    await p.step()
    expect(p.state).toMatchObject({ kind: 'found', candidate: { chatId: 42 } })
  })

  it('gives up after ten minutes', async () => {
    const { p, now } = pairing()
    now.t = T0 + PAIR_WINDOW_MS + 1
    await p.step()
    expect(p.state.kind).toBe('expired')
  })

  it('reports a bot already in use elsewhere', async () => {
    const tg = fakeTelegram({ conflict: true })
    const p = new Pairing(tg.f, BOT_TOKEN, () => T0, 0)
    await p.step()
    expect(p.state).toMatchObject({ kind: 'error', message: expect.stringMatching(/already connected somewhere else/) })
  })
})
