/**
 * Interactive question flow for setup — same questions, same order, same
 * presets as the retired setup.sh, over an injected Prompter so the flow is
 * testable with scripted answers.
 */
import {
  buildEmailSignature,
  type AiProvider,
  type Answers,
  type EmailProvider,
  type EngineChoice,
  type Platform,
} from './plan.js'
import { answersFromSaved, PROVISIONAL, type SavedSetup } from './saved.js'
import { lookUpCity, validName } from './web/answers.js'
import type { Fetch } from './web/telegram.js'

export interface Prompter {
  ask(question: string, def?: string): Promise<string>
  choice(question: string, options: string[]): Promise<string>
  yesNo(question: string): Promise<boolean>
  say(text: string): void
}

/**
 * Side effects the wizard triggers but does not own. Only one so far: the
 * Claude sign-in, which needs a subprocess and stdin handoff and so lives in
 * the readline shell. It runs from here rather than after the wizard so the
 * sign-in follows the question that asked for it, instead of arriving fifteen
 * questions later when the owner has forgotten they chose a subscription.
 */
export interface WizardHooks {
  /** No-ops when this machine is already signed in. */
  signIn?: () => Promise<void>
  /**
   * Checks that the gog CLI (the Gmail/Calendar backend) is installed and
   * offers to install it. Runs right after a Gmail address is given, for the
   * same reason signIn runs mid-wizard: the fix belongs next to the question,
   * not in a list of homework after the wizard exits.
   */
  ensureGog?: () => Promise<void>
}

export interface WizardOptions {
  /** Answers from an earlier run; the profile is reused without a question. */
  saved?: SavedSetup | null
  /** An older install that predates the first-chat profile: ask the profile questions. */
  legacyInstall?: boolean
  /** Fallback timezone when the city lookup gives none. Defaults to UTC. */
  hostTimezone?: string
  /** For the city lookup. Defaults to the global fetch; tests inject one to stay offline. */
  fetch?: Fetch
  /** A provider-run box: no AI question and no voice question; the key is in the vault. */
  managedAi?: boolean
}

type ProfileAnswers = Pick<
  Answers,
  'ownerName' | 'assistantName' | 'timezone' | 'city' | 'personalityVibe' | 'ownerBio' | 'latitude' | 'longitude' | 'tempUnit'
>

const VIBE_LABELS = ['Professional and efficient', 'Friendly and conversational', 'Direct and no-nonsense']

/** Asks until the answer passes validName. `optional` lets a blank answer through. */
async function askName(p: Prompter, question: string, max: number, def?: string, optional = false): Promise<string> {
  for (;;) {
    const v = (await p.ask(question, def)).trim()
    if (optional && v === '') return v
    if (validName(v, max)) return v
    p.say(`Use ${max} characters or fewer, with no quotation marks or backslashes.${optional ? '' : ' This one cannot be blank.'}`)
  }
}

async function askBio(p: Prompter): Promise<string> {
  for (;;) {
    const v = (await p.ask('About you')).trim()
    if (v.length <= 600 && !/[\u0000-\u001f\u007f]/.test(v)) return v
    p.say('Keep it to 600 characters or fewer, on one line.')
  }
}

/** The bot's own name when it is a valid assistant name, otherwise the provisional one. */
export function provisionalAssistantName(botFirstName: string | undefined): string {
  return botFirstName !== undefined && validName(botFirstName, 40) ? botFirstName.trim() : PROVISIONAL.assistantName
}

/**
 * An install that ran setup before the first-chat profile existed: it has a
 * .env (gitignored, written only by setup) but no saved answers. CLAUDE.md is
 * no signal, because the repo ships a placeholder one.
 */
export function isLegacyInstall(state: { envExists: boolean; saved: SavedSetup | null | undefined }): boolean {
  return state.envExists && !state.saved
}

/**
 * The profile questions an older install still gets. Timezone, coordinates and
 * temperature unit are never asked: they come from the city, and the host's
 * timezone and the provisional values stand in when the lookup finds nothing.
 */
async function askLegacyProfile(p: Prompter, opts: WizardOptions): Promise<ProfileAnswers> {
  const ownerName = await askName(p, 'Your name', 80)
  const assistantName = await askName(p, 'Name for your assistant', 40, 'Atlas')
  const city = await askName(p, 'Your city (for weather)', 80, 'New York', true)

  const vibeChoice = await p.choice('How should your assistant communicate?', [...VIBE_LABELS, 'Custom (you will write it)'])
  const presetIndex = VIBE_LABELS.indexOf(vibeChoice)
  const personalityVibe = presetIndex >= 0 ? PERSONALITY_PRESETS[presetIndex] : await p.ask('Describe the vibe in 1-2 sentences')

  p.say('Tell the assistant about yourself (1-3 sentences): role, business, what help you need.')
  const ownerBio = await askBio(p)

  const place = await lookUpCity(opts.fetch ?? fetch, city)
  return {
    ownerName,
    assistantName,
    timezone: place?.timezone ?? opts.hostTimezone ?? 'UTC',
    city,
    personalityVibe,
    ownerBio,
    latitude: place?.latitude ?? PROVISIONAL.latitude,
    longitude: place?.longitude ?? PROVISIONAL.longitude,
    tempUnit: place?.tempUnit ?? PROVISIONAL.tempUnit,
  }
}

function profileFor(saved: SavedSetup | null | undefined, opts: WizardOptions): ProfileAnswers {
  if (saved) {
    return {
      ownerName: saved.ownerName,
      assistantName: saved.assistantName,
      timezone: saved.timezone,
      city: saved.city,
      personalityVibe: saved.personalityVibe,
      ownerBio: saved.ownerBio,
      latitude: saved.latitude,
      longitude: saved.longitude,
      tempUnit: saved.tempUnit,
    }
  }
  return {
    ownerName: PROVISIONAL.ownerName,
    assistantName: PROVISIONAL.assistantName,
    timezone: opts.hostTimezone ?? 'UTC',
    city: '',
    personalityVibe: PERSONALITY_PRESETS[PROVISIONAL.vibeIndex],
    ownerBio: '',
    latitude: PROVISIONAL.latitude,
    longitude: PROVISIONAL.longitude,
    tempUnit: PROVISIONAL.tempUnit,
  }
}

export const PERSONALITY_PRESETS = [
  'Professional, efficient, precise. Communicate clearly without unnecessary filler. Prioritize accuracy and actionability.',
  'Warm but efficient. Conversational tone without being chatty. Personable, remembers context, occasionally lighthearted.',
  'Direct, sharp, no fluff. Say what needs saying and move on. Push back when something doesn\'t make sense. Have opinions.',
]

/** What the engine question collects. Kept separate so it stays readable. */
interface EngineAnswers {
  engine: EngineChoice
  aiProvider?: AiProvider
  aiModel?: string
  anthropicKey?: string
  openaiKey?: string
  googleKey?: string
}

const ENGINE_OPTIONS = [
  'A Claude subscription (Claude Pro or Claude Max)',
  'An API key, billed per use',
  'Neither yet — I will sort this out later',
]

const PROVIDER_OPTIONS: Array<{ label: string; id: AiProvider; where: string }> = [
  { label: 'Anthropic (Claude)', id: 'anthropic', where: 'https://console.anthropic.com/settings/keys' },
  { label: 'OpenAI', id: 'openai', where: 'https://platform.openai.com/api-keys' },
  { label: 'Google (Gemini)', id: 'google', where: 'https://aistudio.google.com/app/apikey' },
]

/**
 * The question this wizard never asked. Setup used to warn about a missing
 * `claude` command and mention "BYOK installs" as the alternative, describing a
 * choice the owner was never offered and using words they had no reason to
 * know. Ask it plainly instead, in terms of what someone actually has.
 */
async function askEngine(p: Prompter, hooks?: WizardHooks): Promise<EngineAnswers> {
  p.say(
    'Your assistant needs an account with an AI company to do its thinking.\n' +
      '  A Claude subscription is a flat monthly fee and you sign in once on this computer.\n' +
      '  An API key has no monthly fee and bills for what you use.\n' +
      '  Either works. You can change your mind later by editing .env.'
  )
  const choice = await p.choice('Which do you have?', ENGINE_OPTIONS)

  if (choice === ENGINE_OPTIONS[0]) {
    await hooks?.signIn?.()
    return { engine: 'subscription' }
  }

  if (choice === ENGINE_OPTIONS[2]) {
    p.say(
      'Fine. Setup will finish, but the assistant cannot answer messages until this is done.\n' +
        '  .env will spell out both options, and the self-test will tell you it is still missing.'
    )
    return { engine: 'later' }
  }

  const providerLabel = await p.choice('Whose API key?', PROVIDER_OPTIONS.map((o) => o.label))
  const provider = PROVIDER_OPTIONS.find((o) => o.label === providerLabel) ?? PROVIDER_OPTIONS[0]
  p.say(`Get a key at ${provider.where}`)
  const key = await p.ask(`${provider.label} API key (leave blank to fill in later)`, '')

  // anthropic is the only provider with a default model id; the others must be
  // named or the runtime refuses to start rather than guess an id that rots.
  let aiModel = ''
  if (provider.id !== 'anthropic') {
    const example = provider.id === 'openai' ? 'gpt-5' : 'gemini-2.5-pro'
    aiModel = await p.ask(`Which model? (required for ${provider.label}, e.g. ${example})`, example)
  }

  return {
    engine: 'api-key',
    aiProvider: provider.id,
    aiModel,
    anthropicKey: provider.id === 'anthropic' ? key : undefined,
    openaiKey: provider.id === 'openai' ? key : undefined,
    googleKey: provider.id === 'google' ? key : undefined,
  }
}

/**
 * Voice runs on OpenAI no matter which company does the thinking: voice notes
 * are transcribed by Whisper, spoken replies come from OpenAI text-to-speech,
 * and live conversation on the voice page is GPT-Live-1. A Claude install was
 * never asked for that key, so voice quietly did nothing (or fell back to macOS
 * `say`) and nobody was told why. Ask once, in terms of what it turns on and
 * what it costs. An OpenAI key already given for the model is reused.
 */
async function askVoice(p: Prompter, keys: Answers['keys']): Promise<void> {
  if (keys.openai !== undefined) {
    p.say('Voice (voice notes, spoken replies, live conversation) will use the OpenAI key you already entered.')
    return
  }
  p.say(
    'Voice: send voice notes, hear replies spoken, and talk live on the voice page.\n' +
      '  Voice uses an OpenAI API key, whichever AI does the thinking. It bills per use:\n' +
      '  live conversation is about $0.05 per minute of talking; notes and spoken replies cost cents.\n' +
      '  Key: https://platform.openai.com/api-keys'
  )
  if (!(await p.yesNo('Enable voice?'))) return
  keys.openai = await p.ask('OpenAI API key (leave blank to fill in later)', '')
  p.say(liveNodeNote(process.versions.node))
}

/**
 * Live conversation needs Node 22 (a built-in WebSocket client); voice notes
 * and spoken replies do not. Say which applies on this machine rather than
 * letting the owner find out from an error on the voice page.
 */
export function liveNodeNote(nodeVersion: string): string {
  const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10)
  if (major >= 22) return 'Voice notes, spoken replies, and live conversation will all work on this computer.'
  return (
    `Voice notes and spoken replies will work. Live conversation on the voice page needs Node 22,\n` +
    `  and this computer is running Node ${nodeVersion}, so that part stays off until Node is upgraded.`
  )
}

/** The optional-skill questions, asked only when the owner opts in. */
async function askOptionalSkills(p: Prompter, skills: Answers['skills'], keys: Answers['keys'], managedAi = false): Promise<void> {
  p.say('Web research (Perplexity): three-tier research with citations. Key: https://www.perplexity.ai/settings/api')
  skills.webResearch = await p.yesNo('Enable web-research skill?')
  if (skills.webResearch) keys.perplexity = await p.ask('Perplexity API key (leave blank to fill in later)', '')

  p.say('Apollo.io: company/person lookups and sequence reports. Key: https://app.apollo.io/#/settings/integrations/api')
  skills.apollo = await p.yesNo('Enable Apollo skill?')
  if (skills.apollo) keys.apollo = await p.ask('Apollo API key (leave blank to fill in later)', '')

  // Wordsmith is always on — it writes directly using the configured LLM,
  // no separate API key needed. The skill template is copied unconditionally
  // by buildPlanActions.

  p.say('Anti-library: structured wiki in an Obsidian vault.')
  skills.antilibrary = await p.yesNo('Enable Anti-library skill?')
  if (skills.antilibrary) keys.obsidianVaultPath = await p.ask('Obsidian vault path (full path)', '~/Documents/Knowledge')

  p.say('Notion: read/search/create pages and databases. Token: https://www.notion.so/profile/integrations')
  skills.notion = await p.yesNo('Enable Notion skill?')
  if (skills.notion) keys.notion = await p.ask('Notion integration token (leave blank to fill in later)', '')

  p.say('Kanban Zone: board state and card CRUD via the public API.')
  skills.kanbanzone = await p.yesNo('Enable Kanban Zone skill?')
  if (skills.kanbanzone) {
    keys.kanbanzone = await p.ask('Kanban Zone API key (leave blank to fill in later)', '')
    keys.kzBoardId = await p.ask('Default board ID (optional)', '')
  }

  if (!managedAi) await askVoice(p, keys)

  p.say('WordPress (drafts-only): reads content, drafts posts, never publishes.')
  skills.wordpress = await p.yesNo('Enable WordPress skill?')
  if (skills.wordpress) {
    keys.wpSiteUrl = await p.ask('WordPress site URL (no trailing slash)', 'https://example.com')
    keys.wpUsername = await p.ask('WordPress username')
    keys.wpAppPassword = await p.ask('Application Password (leave blank to fill in later)', '')
  }
}

export async function runWizard(
  p: Prompter,
  projectPath: string,
  hooks?: WizardHooks,
  opts: WizardOptions = {}
): Promise<Answers> {
  const platform = (await p.choice('Which messaging platform?', ['Telegram', 'Slack', 'Teams'])) as Platform

  // A managed box has no AI step: its key is already in the vault.
  const managed = opts.managedAi === true
  const engineAnswers: EngineAnswers = managed ? { engine: 'managed' } : await askEngine(p, hooks)

  const profile = opts.legacyInstall ? await askLegacyProfile(p, opts) : profileFor(opts.saved, opts)
  const { ownerName } = profile

  // A re-run keeps what the last run chose unless the owner asks to change it.
  const saved = opts.saved
  let emailProvider: EmailProvider = saved ? saved.emailProvider : 'Skip for now'
  let gmailAddress = saved?.gmailAddress ?? ''
  let gmailAddress2 = saved?.gmailAddress2 ?? ''
  let outlookAddress = saved?.outlookAddress ?? ''
  let outlookAddress2 = saved?.outlookAddress2 ?? ''
  if (await p.yesNo(saved ? 'Change email setup?' : 'Connect email now?')) {
    emailProvider = 'Skip for now'
    gmailAddress = ''
    gmailAddress2 = ''
    outlookAddress = ''
    outlookAddress2 = ''
    emailProvider = (await p.choice('Email provider?', ['Gmail', 'Outlook/Microsoft 365', 'Both'])) as EmailProvider
    if (emailProvider === 'Gmail' || emailProvider === 'Both') {
      gmailAddress = await p.ask('Gmail address')
      if (await p.yesNo('Add a second Gmail account?')) gmailAddress2 = await p.ask('Second Gmail address')
      if (gmailAddress) await hooks?.ensureGog?.()
    }
    if (emailProvider === 'Outlook/Microsoft 365' || emailProvider === 'Both') {
      outlookAddress = await p.ask('Outlook email address')
      if (await p.yesNo('Add a second Outlook account?')) outlookAddress2 = await p.ask('Second Outlook email address')
    }
  }
  const emailAddress = gmailAddress || outlookAddress
  const emailSignature = buildEmailSignature({ name: ownerName, title: '', phone: '', email: emailAddress })

  const keys: Answers['keys'] = {
    anthropic: engineAnswers.anthropicKey,
    openai: engineAnswers.openaiKey,
    google: engineAnswers.googleKey,
  }
  const skills: Answers['skills'] = {
    webResearch: false,
    apollo: false,
    antilibrary: false,
    notion: false,
    kanbanzone: false,
    wordpress: false,
  }

  const skillsQuestion = saved
    ? 'Change optional skills?'
    : 'Set up optional skills now (web research, Apollo, Anti-library, Notion, Kanban Zone, voice, WordPress)?'
  if (await p.yesNo(skillsQuestion)) {
    await askOptionalSkills(p, skills, keys, managed)
  } else if (saved) {
    // The skills stay on with their non-secret config (site URL, vault path).
    // Their keys are already on disk from the last run and are not asked again.
    Object.assign(skills, saved.skills)
    Object.assign(keys, answersFromSaved(saved, projectPath).keys)
  }

  return {
    ownerName,
    assistantName: profile.assistantName,
    timezone: profile.timezone,
    city: profile.city,
    platform,
    engine: engineAnswers.engine,
    aiProvider: engineAnswers.aiProvider,
    aiModel: engineAnswers.aiModel,
    personalityVibe: profile.personalityVibe,
    ownerBio: profile.ownerBio,
    emailProvider,
    emailAddress,
    gmailAddress,
    gmailAddress2,
    outlookAddress,
    outlookAddress2,
    emailSignature,
    latitude: profile.latitude,
    longitude: profile.longitude,
    tempUnit: profile.tempUnit,
    monthlyAudit: false,
    skills,
    keys,
    projectPath,
  }
}
