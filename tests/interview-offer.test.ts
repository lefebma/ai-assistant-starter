/**
 * tests/interview-offer.test.ts
 *
 * The discovery interview exists (card 114); this is the part that tells the
 * client it exists (card 106). Two failures are worth guarding against, and
 * they pull in opposite directions:
 *
 *   Silence. A non-technical owner installs the assistant, opens an empty
 *   chat, and never learns the interview is there. That is the whole problem
 *   card 106 was filed for, so a missing profile must produce an offer even on
 *   installs that were already running when this shipped.
 *
 *   Nagging. An assistant that asks to interview you every morning is worse
 *   than one that never asks. Once the offer has been delivered, it is spent,
 *   whether or not the client took it up.
 *
 * The state that separates those two lives in app_state and in PROFILE.md, so
 * the tests inject both rather than touching a real database or a real file.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OFFER_STATE_KEY,
  PROFILE_STUB_MARKER,
  interviewGreeting,
  interviewNudge,
  markInterviewOffered,
  profileIsUnwritten,
  shouldOfferInterview,
} from '../src/onboarding/interview-offer.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** An install root with the given PROFILE.md, or none at all. */
function installWithProfile(contents?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'interview-offer-'))
  if (contents !== undefined) writeFileSync(join(root, 'PROFILE.md'), contents)
  return root
}

const STUB = readFileSync(join(REPO, 'templates', 'PROFILE.md.template'), 'utf-8')
const REAL_PROFILE = '# Profile\n\nSam runs a three person consultancy in Toronto.\n'

describe('profileIsUnwritten', () => {
  it('treats a missing PROFILE.md as unwritten', () => {
    expect(profileIsUnwritten(installWithProfile())).toBe(true)
  })

  it('treats the scaffolded stub as unwritten', () => {
    expect(profileIsUnwritten(installWithProfile(STUB))).toBe(true)
  })

  it('treats a profile the interview wrote as written', () => {
    expect(profileIsUnwritten(installWithProfile(REAL_PROFILE))).toBe(false)
  })
})

describe('shouldOfferInterview', () => {
  const never = () => null

  it('offers when there is no profile and no prior offer', () => {
    expect(shouldOfferInterview(installWithProfile(STUB), { getState: never })).toBe(true)
  })

  it('offers on installs that predate the stub, where no PROFILE.md exists', () => {
    expect(shouldOfferInterview(installWithProfile(), { getState: never })).toBe(true)
  })

  it('stays quiet once the offer has been made, even with no profile', () => {
    const sent = (k: string) => (k === OFFER_STATE_KEY ? '2026-08-30T12:00:00.000Z' : null)
    expect(shouldOfferInterview(installWithProfile(STUB), { getState: sent })).toBe(false)
  })

  it('stays quiet once a profile exists, even with no flag', () => {
    expect(shouldOfferInterview(installWithProfile(REAL_PROFILE), { getState: never })).toBe(false)
  })
})

describe('markInterviewOffered', () => {
  it('records a timestamp under the offer key', () => {
    const written: Record<string, string> = {}
    markInterviewOffered((k, v) => {
      written[k] = v
    })
    expect(Object.keys(written)).toEqual([OFFER_STATE_KEY])
    expect(new Date(written[OFFER_STATE_KEY]).getTime()).not.toBeNaN()
  })

  it('suppresses the next check when its write is read back', () => {
    const store: Record<string, string> = {}
    const root = installWithProfile(STUB)
    expect(shouldOfferInterview(root, { getState: (k) => store[k] ?? null })).toBe(true)
    markInterviewOffered((k, v) => {
      store[k] = v
    })
    expect(shouldOfferInterview(root, { getState: (k) => store[k] ?? null })).toBe(false)
  })
})

describe('the offer copy', () => {
  it('names the phrase that starts the interview', () => {
    expect(interviewGreeting()).toContain('interview me')
    expect(interviewNudge()).toContain('interview me')
  })

  it('greets by name when there is one, and reads correctly when there is not', () => {
    expect(interviewGreeting('Sam')).toContain('Hi Sam,')
    expect(interviewGreeting()).toContain('Hi, ')
    expect(interviewGreeting('   ')).toContain('Hi, ')
  })

  it('tells the assistant to answer the message before raising the interview', () => {
    // A client whose actual question gets ignored in favour of a pitch has
    // learned something worse than the pitch was worth.
    const nudge = interviewNudge()
    expect(nudge).toMatch(/answer what was asked first/i)
    expect(nudge).toMatch(/do not raise it again/i)
  })

  it('is addressed to the assistant, not the client, so it never ships verbatim', () => {
    expect(interviewNudge().startsWith('[Onboarding:')).toBe(true)
  })
})

describe('the marker is shared, not duplicated', () => {
  it('is carried by the scaffolded PROFILE.md', () => {
    expect(STUB).toContain(PROFILE_STUB_MARKER)
  })

  it('is known to the interview skill, which has to remove it', () => {
    const skill = readFileSync(join(REPO, 'templates', 'skills', 'exec-interview', 'SKILL.md'), 'utf-8')
    expect(skill).toContain(PROFILE_STUB_MARKER)
  })
})

describe('the hooks spend the offer only on delivery', () => {
  // Both call sites are one line each and easy to "tidy" into the wrong place.
  // Marking before the send is the bug that costs a client the offer entirely:
  // Teams cannot message a conversation it has never heard from, so a fresh
  // Teams install fails that send every time.
  it('marks after the startup greeting sends, never in its catch', () => {
    const index = readFileSync(join(REPO, 'src', 'index.ts'), 'utf-8')
    const block = index.slice(index.indexOf('shouldOfferInterview(PROJECT_ROOT)'))
    const send = block.indexOf('adapter.sendMessage')
    const mark = block.indexOf('markInterviewOffered()')
    const caught = block.indexOf('} catch')
    expect(send).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(send)
    expect(mark).toBeLessThan(caught)
  })

  it('marks after the reply carrying the nudge is delivered', () => {
    const bot = readFileSync(join(REPO, 'src', 'bot.ts'), 'utf-8')
    const nudged = bot.indexOf('const onboardingNudge')
    const deliver = bot.indexOf('// Format and deliver')
    const mark = bot.indexOf('if (offerInterview) markInterviewOffered()')
    expect(nudged).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(deliver)
  })
})
