/**
 * The first chat on a minimal setup (card #210).
 *
 * A minimal setup asks only for Telegram and AI access, then writes the
 * profile files from provisional values (src/setup/saved.ts). This is where
 * the owner fills them in: the bot greets on startup with five short
 * questions, and the next few inbound turns carry an instruction telling the
 * assistant to save the answers with the profile CLI.
 *
 * Two properties matter:
 *
 * 1. **A few turns, then quiet.** The instruction rides at most three inbound
 *    turns in the primary chat. An owner who ignores the questions has said
 *    something too, so after the third the profile is skipped, which keeps
 *    the provisional values and frees the interview offer to run.
 * 2. **Nothing changes on an existing install.** Without store/setup-answers.json
 *    a box is never pending, so none of this ever fires there.
 */
import { getAppState, setAppState } from '../db.js'
import { PROVISIONAL, isProfilePending, type SavedSetup } from '../setup/saved.js'
import { RESTART_AFTER_REPLY_KEY, skipProfile } from './profile.js'

/** app_state key holding how many inbound turns have carried the welcome, as a string. */
export const WELCOME_TURNS_KEY = 'welcome_turns'

export const MAX_WELCOME_TURNS = 3

/** app_state key holding an ISO timestamp: the startup greeting reached the owner. */
export const WELCOME_GREETED_KEY = 'welcome_greeted'

/**
 * Sent when the profile CLI promised a restart for a new time zone but no
 * supervisor will bring the process back, so the promise cannot be kept.
 */
export const NO_RESTART_MESSAGE = "I couldn't restart myself here, so the new time zone applies the next time I'm restarted."

const SET_COMMAND =
  'node dist/scripts/profile.js set [--owner-name "..."] [--assistant-name "..."] [--city "..."] ' +
  '[--vibe professional|friendly|direct|"<their words>"] [--bio "..."]'
const SKIP_COMMAND = 'node dist/scripts/profile.js skip'

function turnsSoFar(getState: (k: string) => string | null): number {
  const n = Number.parseInt(getState(WELCOME_TURNS_KEY) ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Whether this inbound turn should carry the welcome instruction. */
export function shouldWelcome(projectRoot: string, getState: (k: string) => string | null = getAppState): boolean {
  return isProfilePending(projectRoot) && turnsSoFar(getState) < MAX_WELCOME_TURNS
}

/**
 * Whether to send the startup greeting. Once, like the interview greeting:
 * an owner who never replies should not hear the questions on every boot.
 */
export function shouldGreetWelcome(projectRoot: string, getState: (k: string) => string | null = getAppState): boolean {
  return !getState(WELCOME_GREETED_KEY) && isProfilePending(projectRoot)
}

/**
 * Record that the greeting reached the owner. Call only after a successful
 * send: a failed one leaves the questions to the nudge on the first turns.
 */
export function markWelcomeGreeted(setState: (k: string, v: string) => void = setAppState): void {
  setState(WELCOME_GREETED_KEY, new Date().toISOString())
}

export interface WelcomeTurnDeps {
  getState?: (k: string) => string | null
  setState?: (k: string, v: string) => void
  /** Defaults to skipProfile; injected in tests. */
  skip?: (root: string) => void
}

/**
 * Count a delivered turn that carried the welcome. On the last one, a profile
 * still pending is skipped: the provisional values stay and the interview
 * offer takes over.
 */
export function noteWelcomeTurn(projectRoot: string, deps: WelcomeTurnDeps = {}): void {
  const read = deps.getState ?? getAppState
  const write = deps.setState ?? setAppState
  const turns = turnsSoFar(read) + 1
  write(WELCOME_TURNS_KEY, String(turns))
  if (turns >= MAX_WELCOME_TURNS && isProfilePending(projectRoot)) (deps.skip ?? skipProfile)(projectRoot)
}

/**
 * Whether the profile CLI asked for a restart once this reply is out (a new
 * time zone only takes effect on a fresh process). Cleared on read, so a
 * restart that crashes on the way back cannot loop.
 */
export function takeRestartAfterReply(
  getState: (k: string) => string | null = getAppState,
  setState: (k: string, v: string) => void = setAppState
): boolean {
  if (!getState(RESTART_AFTER_REPLY_KEY)) return false
  setState(RESTART_AFTER_REPLY_KEY, '')
  return true
}

/** A name worth using, or '' for the provisional stand-in. */
function realOwnerName(ownerName: unknown): string {
  const name = typeof ownerName === 'string' ? ownerName.trim() : ''
  return name && name !== PROVISIONAL.ownerName ? name : ''
}

/**
 * The unprompted startup message. Plain text, like the interview greeting:
 * it goes out before any conversation exists.
 */
export function welcomeGreeting(ownerName: string, assistantName: string): string {
  const name = realOwnerName(ownerName)
  return [
    `Hi${name ? ` ${name}` : ''}, I'm ${assistantName}, and I'm up and running.`,
    '',
    'A few quick things so I can be useful. Answer in one message if you like, or say "skip":',
    `1. Should I call you ${name || 'something'}?`,
    `2. Is ${assistantName} a good name for me, or would you like another?`,
    '3. Which city are you in? (For the weather and your time zone.)',
    '4. How should I talk to you: professional, friendly, or direct? Or describe it.',
    '5. In a sentence, what do you do?',
  ].join('\n')
}

/**
 * Instruction folded into the first few inbound turns. Written to the
 * assistant, not the owner. The saved file is not shape-checked, so every
 * field is read defensively.
 */
export function welcomeNudge(saved: SavedSetup): string {
  const owner = realOwnerName(saved?.ownerName)
  const assistant = typeof saved?.assistantName === 'string' && saved.assistantName.trim() ? saved.assistantName.trim() : PROVISIONAL.assistantName
  const city = typeof saved?.city === 'string' ? saved.city.trim() : ''
  const bio = typeof saved?.ownerBio === 'string' ? saved.ownerBio.trim() : ''

  const provisional = [
    owner ? `their name (taken from Telegram as "${owner}", not confirmed)` : 'their name (unknown)',
    `your name (currently "${assistant}", a placeholder)`,
    ...(city ? [] : ['their city (none yet)']),
    'how you should talk to them (a friendly default for now)',
    ...(bio ? [] : ['what they do (nothing yet)']),
  ]

  return [
    '[Onboarding: this install was set up with placeholder profile values. On startup the owner was asked what to',
    'call them, whether your name suits, their city, how you should talk to them, and what they do.',
    `Still provisional: ${provisional.join('; ')}.`,
    'Answer what was asked first, normally and completely. If this message answers any of the questions, save the',
    'answers by running, with only the flags they gave:',
    `    ${SET_COMMAND}`,
    `If they decline or say "skip", run: ${SKIP_COMMAND}`,
    'On a bundle install with no system node, use ./runtime/bin/node (macOS, Linux) or runtime\\node.exe (Windows).',
    'Relay the command output in your own words. Then, at most once and briefly, ask only for what is still missing;',
    'never repeat a question they already answered. Ask for a city by name only.',
    'Never ask for coordinates or a time zone name: the city gives both.',
    'This note appears for a few messages only, so do not keep pressing.]',
  ].join('\n')
}
