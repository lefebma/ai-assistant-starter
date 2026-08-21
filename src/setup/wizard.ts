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

const PERSONALITY_PRESETS = [
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

export async function runWizard(p: Prompter, projectPath: string, hooks?: WizardHooks): Promise<Answers> {
  const ownerName = await p.ask('Your name')
  const assistantName = await p.ask('Name for your assistant', 'Atlas')
  const timezone = await p.ask('Your timezone', 'America/New_York')
  const city = await p.ask('Your city (for weather)', 'New York')

  const platform = (await p.choice('Which messaging platform?', ['Telegram', 'Slack', 'Discord', 'Teams'])) as Platform

  const engineAnswers = await askEngine(p, hooks)

  const vibeChoice = await p.choice('How should your assistant communicate?', [
    'Professional and efficient',
    'Friendly and conversational',
    'Direct and no-nonsense',
    'Custom (you will write it)',
  ])
  const presetIndex = ['Professional and efficient', 'Friendly and conversational', 'Direct and no-nonsense'].indexOf(vibeChoice)
  const personalityVibe = presetIndex >= 0 ? PERSONALITY_PRESETS[presetIndex] : await p.ask('Describe the vibe in 1-2 sentences')

  p.say('Tell the assistant about yourself (1-3 sentences): role, business, what help you need.')
  const ownerBio = await p.ask('About you')

  const emailProvider = (await p.choice('Email provider?', [
    'Gmail',
    'Outlook/Microsoft 365',
    'Both',
    'Skip for now',
  ])) as EmailProvider

  let gmailAddress = ''
  let gmailAddress2 = ''
  let outlookAddress = ''
  let outlookAddress2 = ''
  if (emailProvider === 'Gmail' || emailProvider === 'Both') {
    gmailAddress = await p.ask('Gmail address')
    if (await p.yesNo('Add a second Gmail account?')) gmailAddress2 = await p.ask('Second Gmail address')
    if (gmailAddress) await hooks?.ensureGog?.()
  }
  if (emailProvider === 'Outlook/Microsoft 365' || emailProvider === 'Both') {
    outlookAddress = await p.ask('Outlook email address')
    if (await p.yesNo('Add a second Outlook account?')) outlookAddress2 = await p.ask('Second Outlook email address')
  }
  const emailAddress = gmailAddress || outlookAddress

  const sigName = await p.ask('Name for email signature', ownerName)
  const sigTitle = await p.ask('Title/role', '')
  const sigPhone = await p.ask('Phone', '')
  const sigEmail = await p.ask('Email', emailAddress)
  const emailSignature = buildEmailSignature({ name: sigName, title: sigTitle, phone: sigPhone, email: sigEmail })

  p.say('Weather skill setup — look up coordinates at https://www.latlong.net/')
  const latitude = await p.ask('Latitude', '40.71')
  const longitude = await p.ask('Longitude', '-74.01')
  const tempUnit = (await p.choice('Temperature unit?', ['celsius', 'fahrenheit'])) as 'celsius' | 'fahrenheit'

  const keys: Answers['keys'] = {
    anthropic: engineAnswers.anthropicKey,
    openai: engineAnswers.openaiKey,
    google: engineAnswers.googleKey,
  }
  const skills: Answers['skills'] = {
    webResearch: false,
    apollo: false,
    wordsmith: false,
    antilibrary: false,
    notion: false,
    kanbanzone: false,
    wordpress: false,
  }

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

  p.say('WordPress (drafts-only): reads content, drafts posts, never publishes.')
  skills.wordpress = await p.yesNo('Enable WordPress skill?')
  if (skills.wordpress) {
    keys.wpSiteUrl = await p.ask('WordPress site URL (no trailing slash)', 'https://example.com')
    keys.wpUsername = await p.ask('WordPress username')
    keys.wpAppPassword = await p.ask('Application Password (leave blank to fill in later)', '')
  }

  return {
    ownerName,
    assistantName,
    timezone,
    city,
    platform,
    engine: engineAnswers.engine,
    aiProvider: engineAnswers.aiProvider,
    aiModel: engineAnswers.aiModel,
    personalityVibe,
    ownerBio,
    emailProvider,
    emailAddress,
    gmailAddress,
    gmailAddress2,
    outlookAddress,
    outlookAddress2,
    emailSignature,
    latitude,
    longitude,
    tempUnit,
    skills,
    keys,
    projectPath,
  }
}
