/**
 * Who a /request is from (card #240). havn-test sent "your name (not set)" and
 * the box's address as the assistant's name: it was set up before
 * store/setup-answers.json existed, so the names must come from the files.
 */
import { describe, it, expect } from 'vitest'
import { resolveAssistantName, resolveOwnerName, type SenderSources } from '../src/request/sender.js'

const NONE: SenderSources = { env: {}, saved: null, personality: null, claudeMd: null }
const OLD_BOX: SenderSources = {
  env: {},
  saved: null,
  personality: "## Personality\n\nYour name is Nami. You're not just an assistant.",
  claudeMd: "# t_havn_ecker\n\nYou are Marc's personal AI assistant, accessible via Telegram.",
}

describe('request sender', () => {
  it('reads both names from the files on a box with no saved answers', () => {
    expect(resolveOwnerName(OLD_BOX)).toBe('Marc')
    expect(resolveAssistantName(OLD_BOX)).toBe('Nami')
  })

  it('prefers the environment, then the saved answers', () => {
    const s = { ...OLD_BOX, saved: { ownerName: 'Leif', assistantName: 'Avery' } }
    expect(resolveOwnerName(s)).toBe('Leif')
    expect(resolveOwnerName({ ...s, env: { OWNER_NAME: 'Joy' } })).toBe('Joy')
    expect(resolveAssistantName({ ...s, env: { ASSISTANT_NAME: 'Kai' } })).toBe('Kai')
  })

  it('never passes the setup stand-in off as the owner', () => {
    expect(resolveOwnerName({ ...NONE, saved: { ownerName: 'the owner' } })).toBe('')
    expect(resolveOwnerName({ ...OLD_BOX, saved: { ownerName: 'the owner' } })).toBe('Marc')
  })

  it('ignores template placeholders and answers empty when nothing names them', () => {
    const tpl = { ...NONE, personality: 'Your name is {{ASSISTANT_NAME}}.', claudeMd: "You are {{OWNER_NAME}}'s personal AI assistant" }
    expect(resolveOwnerName(tpl)).toBe('')
    expect(resolveAssistantName(tpl)).toBe('')
    expect(resolveOwnerName(NONE)).toBe('')
    expect(resolveAssistantName(NONE)).toBe('')
  })

  it('falls back to the saved assistant name when the files name none', () => {
    expect(resolveAssistantName({ ...NONE, saved: { assistantName: 'Atlas' } })).toBe('Atlas')
  })
})
