/**
 * tests/onboarding-welcome.test.ts
 *
 * The first chat on a minimal setup (card #210). The bot greets with five
 * questions and folds an instruction into the next few inbound turns so the
 * assistant saves the answers. Two things must hold: the instruction stops
 * after three turns, and a profile still pending then is skipped so the
 * interview offer can take over.
 *
 * State is injected as a plain map; the answers file is real, in a tmp root.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MAX_WELCOME_TURNS,
  WELCOME_TURNS_KEY,
  noteWelcomeTurn,
  shouldWelcome,
  takeRestartAfterReply,
  welcomeGreeting,
  welcomeNudge,
} from '../src/onboarding/welcome.js'
import { RESTART_AFTER_REPLY_KEY, skipProfile } from '../src/onboarding/profile.js'
import { shouldOfferInterview } from '../src/onboarding/interview-offer.js'
import { isProfilePending, loadSetupAnswers, saveSetupAnswers } from '../src/setup/saved.js'
import { buildEmailSignature, type Answers } from '../src/setup/plan.js'
import { PERSONALITY_PRESETS } from '../src/setup/wizard.js'

const STUB = readFileSync(resolve(__dirname, '..', 'templates', 'PROFILE.md.template'), 'utf-8')

function answers(root: string, overrides: Partial<Answers> = {}): Answers {
  return {
    ownerName: 'the owner',
    assistantName: 'Atlas',
    timezone: 'America/New_York',
    city: '',
    platform: 'Telegram',
    engine: 'subscription',
    personalityVibe: PERSONALITY_PRESETS[1]!,
    ownerBio: '',
    emailProvider: 'Skip for now',
    emailAddress: '',
    gmailAddress: '',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: buildEmailSignature({ name: 'the owner', title: '', phone: '', email: '' }),
    latitude: '40.71',
    longitude: '-74.01',
    tempUnit: 'celsius',
    monthlyAudit: false,
    skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    keys: {},
    projectPath: root,
    ...overrides,
  }
}

/** A tmp root with the scaffolded PROFILE.md and, optionally, a saved setup. */
function install(pending?: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-welcome-'))
  writeFileSync(join(root, 'PROFILE.md'), STUB)
  if (pending !== undefined) saveSetupAnswers(root, answers(root), pending)
  return root
}

function stateMap(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    getState: (k: string) => store[k] || null,
    setState: (k: string, v: string) => {
      store[k] = v
    },
  }
}

describe('shouldWelcome', () => {
  it('false without answers file', () => {
    expect(shouldWelcome(install(), stateMap().getState)).toBe(false)
  })

  it('false when the saved setup is not pending', () => {
    expect(shouldWelcome(install(false), stateMap().getState)).toBe(false)
  })

  it('true when pending and 0 turns', () => {
    expect(shouldWelcome(install(true), stateMap().getState)).toBe(true)
  })

  it('false at 3 turns', () => {
    const s = stateMap({ [WELCOME_TURNS_KEY]: String(MAX_WELCOME_TURNS) })
    expect(MAX_WELCOME_TURNS).toBe(3)
    expect(shouldWelcome(install(true), s.getState)).toBe(false)
  })
})

describe('noteWelcomeTurn', () => {
  it('third call skips', () => {
    const root = install(true)
    const s = stateMap()
    noteWelcomeTurn(root, s)
    noteWelcomeTurn(root, s)
    expect(isProfilePending(root)).toBe(true)
    expect(shouldWelcome(root, s.getState)).toBe(true)
    noteWelcomeTurn(root, s)
    expect(s.store[WELCOME_TURNS_KEY]).toBe('3')
    expect(isProfilePending(root)).toBe(false)
    expect(shouldWelcome(root, s.getState)).toBe(false)
    // The interview offer was held back while pending; now it is free to run.
    expect(shouldOfferInterview(root, { getState: () => null })).toBe(true)
  })

  it('does not skip once set', () => {
    const root = install(true)
    const s = stateMap()
    const skip = vi.fn(skipProfile)
    noteWelcomeTurn(root, { getState: s.getState, setState: s.setState, skip })
    noteWelcomeTurn(root, { getState: s.getState, setState: s.setState, skip })
    // `set` ran in between and cleared the flag.
    saveSetupAnswers(root, answers(root, { ownerName: 'Jane' }), false)
    noteWelcomeTurn(root, { getState: s.getState, setState: s.setState, skip })
    expect(skip).not.toHaveBeenCalled()
    expect(loadSetupAnswers(root)?.ownerName).toBe('Jane')
  })
})

describe('welcomeGreeting', () => {
  it('greeting with provisional owner has no name', () => {
    const g = welcomeGreeting('the owner', 'Atlas')
    expect(g.startsWith("Hi, I'm Atlas, and I'm up and running.")).toBe(true)
    expect(g).toContain('1. Should I call you something?')
    expect(g).not.toContain('the owner')
  })

  it('greeting with name', () => {
    const g = welcomeGreeting('Jane', 'Nami')
    expect(g.startsWith("Hi Jane, I'm Nami, and I'm up and running.")).toBe(true)
    expect(g).toContain('1. Should I call you Jane?')
    expect(g).toContain('2. Is Nami a good name for me, or would you like another?')
    expect(g).toContain('Answer in one message if you like, or say "skip":')
    expect(g).toContain('5. In a sentence, what do you do?')
  })
})

describe('welcomeNudge', () => {
  it('nudge carries the command', () => {
    const root = install(true)
    const n = welcomeNudge(loadSetupAnswers(root)!)
    expect(n).toContain('node dist/scripts/profile.js set')
    expect(n).toContain('node dist/scripts/profile.js skip')
    expect(n).not.toContain('\u2014')
    expect(n).toMatch(/answer what was asked first/i)
    expect(n).toMatch(/never ask for coordinates or a time zone/i)
    expect(n.startsWith('[Onboarding:')).toBe(true)
  })

  it('names the provisional values it is holding', () => {
    const root = install(true)
    const n = welcomeNudge({ ...loadSetupAnswers(root)!, ownerName: 'Jane', assistantName: 'Nami' })
    expect(n).toContain('"Jane"')
    expect(n).toContain('"Nami"')
    expect(n).toMatch(/city/i)
  })

  it('survives a saved file with missing fields', () => {
    expect(() => welcomeNudge({} as never)).not.toThrow()
  })
})

describe('takeRestartAfterReply', () => {
  it('takeRestartAfterReply reads once', () => {
    const s = stateMap({ [RESTART_AFTER_REPLY_KEY]: '2026-10-20T12:00:00.000Z' })
    expect(takeRestartAfterReply(s.getState, s.setState)).toBe(true)
    expect(takeRestartAfterReply(s.getState, s.setState)).toBe(false)
  })

  it('is false when nothing asked for a restart', () => {
    const s = stateMap()
    expect(takeRestartAfterReply(s.getState, s.setState)).toBe(false)
  })
})
