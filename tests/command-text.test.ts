import { describe, it, expect } from 'vitest'
import { commandWord } from '../src/infra/command-text.js'
import { decideAccess } from '../src/access.js'

describe('commandWord', () => {
  it('normalises case, which is the bug that broke a fresh install', () => {
    // Reported from a real install: the owner typed /chatID, got nothing.
    expect(commandWord('/chatID')).toBe('/chatid')
    expect(commandWord('/ChatId')).toBe('/chatid')
    expect(commandWord('/HELP')).toBe('/help')
  })

  it('ignores surrounding whitespace and trailing arguments', () => {
    expect(commandWord('  /chatid  ')).toBe('/chatid')
    expect(commandWord('/Schedule list')).toBe('/schedule')
    expect(commandWord('/authorize add 12345')).toBe('/authorize')
  })

  it('strips the @bot suffix Telegram adds in group chats', () => {
    expect(commandWord('/chatid@MyAssistantBot')).toBe('/chatid')
    expect(commandWord('/skill@MyBot list')).toBe('/skill')
  })

  it('returns empty for anything that is not a command', () => {
    expect(commandWord('hello there')).toBe('')
    expect(commandWord('')).toBe('')
    expect(commandWord('   ')).toBe('')
    expect(commandWord('email me the /report')).toBe('')
  })

  it('does not lowercase arguments, only the command word', () => {
    // The helper returns the word alone; handlers get the original text so
    // chat ids, skill names and prompts keep their case.
    expect(commandWord('/authorize add AbC123')).toBe('/authorize')
  })
})

describe('access gate and router agree', () => {
  const unconfigured = (text: string) =>
    decideAccess({ chatId: '99', text, primaryChatId: '', isExtraChat: () => false })

  it('lets the bootstrap commands through whatever the capitalisation', () => {
    for (const text of ['/chatid', '/chatID', '/ChatId', '/start', '/START', '/help', '/Help']) {
      expect(unconfigured(text).allow, text).toBe(true)
    }
  })

  it('lets them through addressed to a named bot in a group', () => {
    expect(unconfigured('/chatID@MyAssistantBot').allow).toBe(true)
  })

  it('still refuses everything else on an unconfigured install', () => {
    const denied = unconfigured('what is in my inbox')
    expect(denied.allow).toBe(false)
    expect(denied.reply).toMatch(/not set up yet/i)
    // Must not hand a stranger the command to claim the install.
    expect(denied.reply).not.toMatch(/\/authorize add/)
    expect(unconfigured('/schedule list').allow).toBe(false)
  })

  it('once configured, only the owner and authorized chats get in', () => {
    const q = (chatId: string, extra = false) =>
      decideAccess({ chatId, text: '/chatid', primaryChatId: '42', isExtraChat: () => extra })
    expect(q('42').allow).toBe(true)
    expect(q('99').allow).toBe(false)
    expect(q('99', true).allow).toBe(true)
  })
})
