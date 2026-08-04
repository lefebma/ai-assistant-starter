import { describe, it, expect } from 'vitest'
import { decideAccess } from '../src/access.js'

const PRIMARY = '123456789'
const allowNone = () => false
const allowAny = () => true

describe('decideAccess once configured', () => {
  it('lets the owner through', () => {
    expect(decideAccess({ chatId: PRIMARY, text: 'hello', primaryChatId: PRIMARY, isExtraChat: allowNone }).allow).toBe(true)
  })

  it('lets an explicitly authorized second chat through', () => {
    expect(decideAccess({ chatId: '999', text: 'hello', primaryChatId: PRIMARY, isExtraChat: allowAny }).allow).toBe(true)
  })

  it('turns a stranger away and tells them how to be added', () => {
    const d = decideAccess({ chatId: '999', text: 'hello', primaryChatId: PRIMARY, isExtraChat: allowNone })
    expect(d.allow).toBe(false)
    expect(d.reply).toMatch(/authorize add 999/)
  })
})

describe('decideAccess before ALLOWED_CHAT_ID is set', () => {
  // This is the dangerous window: the setup wizard now starts the assistant in
  // the background before the owner has a chat ID to lock it with. Previously
  // an empty ALLOWED_CHAT_ID meant everyone was authorized.
  const unconfigured = { primaryChatId: '', isExtraChat: allowNone }

  it('still answers /chatid, because that is how the owner learns their id', () => {
    expect(decideAccess({ chatId: '999', text: '/chatid', ...unconfigured }).allow).toBe(true)
  })

  it('tolerates surrounding whitespace and case on the bootstrap command', () => {
    expect(decideAccess({ chatId: '999', text: '  /ChatID  ', ...unconfigured }).allow).toBe(true)
  })

  it('answers /start, which Telegram sends when anyone opens the bot', () => {
    expect(decideAccess({ chatId: '999', text: '/start', ...unconfigured }).allow).toBe(true)
  })

  it('refuses an ordinary message instead of treating everyone as the owner', () => {
    const d = decideAccess({ chatId: '999', text: 'what is in my inbox', ...unconfigured })
    expect(d.allow).toBe(false)
  })

  it('refuses commands that touch the owner data, not just free text', () => {
    for (const text of ['/memory', '/schedule list', '/skill list', '/update']) {
      expect(decideAccess({ chatId: '999', text, ...unconfigured }).allow).toBe(false)
    }
  })

  it('tells the owner exactly what to do, since they are who is usually typing', () => {
    const d = decideAccess({ chatId: '999', text: 'hello', ...unconfigured })
    expect(d.reply).toMatch(/ALLOWED_CHAT_ID/)
    expect(d.reply).toMatch(/\/chatid/)
  })

  it('does not hand a stranger the owner chat id', () => {
    const d = decideAccess({ chatId: '999', text: 'hello', ...unconfigured })
    expect(d.reply).not.toMatch(/authorize add/)
  })
})
