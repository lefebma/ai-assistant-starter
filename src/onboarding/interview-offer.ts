/**
 * Offering the discovery interview, exactly once.
 *
 * The interview skill (templates/skills/exec-interview) is useless if nobody
 * knows it exists, and a non-technical client who installs the assistant and
 * opens an empty chat has no way to find out. So the assistant raises it
 * itself: unprompted on startup where the platform allows that, and otherwise
 * folded into the reply to whatever the client says first.
 *
 * Two properties matter more than the wording:
 *
 * 1. **Once, ever.** An assistant that asks to interview you every morning is
 *    worse than one that never asks. The flag is set when the offer actually
 *    reaches the client, and nothing clears it. Declining is fine: they can
 *    say "interview me" whenever they change their mind.
 * 2. **A failed send is not an offer.** Teams cannot send into a conversation
 *    it has never received a message from (see platform/teams/conversations.ts),
 *    so the startup greeting is a no-op on a fresh Teams install. If the flag
 *    were set optimistically there, that client would never be told at all.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAppState, setAppState } from '../db.js'

/**
 * Marker carried by the scaffolded PROFILE.md. The interview writes the file
 * from scratch, so the marker is gone the moment a real profile exists. A
 * missing file counts as unwritten too: installs that predate the profile
 * never had one scaffolded.
 */
export const PROFILE_STUB_MARKER = 'havn:profile-stub'

export const OFFER_STATE_KEY = 'interview_offer_sent'

/** True when no discovery interview has produced a profile on this install. */
export function profileIsUnwritten(projectRoot: string): boolean {
  try {
    return readFileSync(resolve(projectRoot, 'PROFILE.md'), 'utf-8').includes(PROFILE_STUB_MARKER)
  } catch {
    return true
  }
}

export interface OfferDeps {
  /** Defaults to the app_state table; injected in tests. */
  getState?: (key: string) => string | null
}

/** Whether the client should still hear about the interview. */
export function shouldOfferInterview(projectRoot: string, deps: OfferDeps = {}): boolean {
  const read = deps.getState ?? getAppState
  if (read(OFFER_STATE_KEY)) return false
  return profileIsUnwritten(projectRoot)
}

/** Record that the offer reached the client. Call only after a successful send. */
export function markInterviewOffered(setState: (k: string, v: string) => void = setAppState): void {
  setState(OFFER_STATE_KEY, new Date().toISOString())
}

/**
 * The unprompted startup message. Plain text: it goes out before any
 * conversation exists, on whatever platform, and formatting is the least of
 * what could go wrong there.
 */
export function interviewGreeting(ownerName?: string): string {
  const who = ownerName?.trim() ? ` ${ownerName.trim()}` : ''
  return [
    `Hi${who}, I'm set up and running.`,
    '',
    "I don't know anything about you or your business yet, which limits me to answering what you ask instead of knowing what matters. There's a 15 to 20 minute conversation that fixes it: your role, the people who come up most, what you're pushing on this quarter, and how you want me to work.",
    '',
    'Say "interview me" whenever you have the time. It can be voice notes, and you can stop partway and pick it up later.',
  ].join('\n')
}

/**
 * Instruction folded into the first inbound turn. Written to the assistant,
 * not the client: it has to answer the actual message first, because a client
 * whose question gets ignored in favour of a pitch has learned something worse
 * than the pitch was worth.
 */
export function interviewNudge(): string {
  return [
    '[Onboarding: no discovery interview has been run on this install, and this note will not appear again.',
    'Answer what was asked first, normally and completely. Then, in a sentence or two at the end, mention that you',
    'do not know much about them or their business yet, that there is a 15 to 20 minute interview that fixes it,',
    'and that they can start it any time by saying "interview me". Offer it once and drop it: if they say no, or say',
    'nothing about it, do not raise it again.]',
  ].join('\n')
}
