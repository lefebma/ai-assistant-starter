/**
 * Interactive question flow for setup — same questions, same order, same
 * presets as the retired setup.sh, over an injected Prompter so the flow is
 * testable with scripted answers.
 */
import { buildEmailSignature, type Answers, type EmailProvider, type Platform } from './plan.js'

export interface Prompter {
  ask(question: string, def?: string): Promise<string>
  choice(question: string, options: string[]): Promise<string>
  yesNo(question: string): Promise<boolean>
  say(text: string): void
}

const PERSONALITY_PRESETS = [
  'Professional, efficient, precise. Communicate clearly without unnecessary filler. Prioritize accuracy and actionability.',
  'Warm but efficient. Conversational tone without being chatty. Personable, remembers context, occasionally lighthearted.',
  'Direct, sharp, no fluff. Say what needs saying and move on. Push back when something doesn\'t make sense. Have opinions.',
]

export async function runWizard(p: Prompter, projectPath: string): Promise<Answers> {
  const ownerName = await p.ask('Your name')
  const assistantName = await p.ask('Name for your assistant', 'Atlas')
  const timezone = await p.ask('Your timezone', 'America/New_York')
  const city = await p.ask('Your city (for weather)', 'New York')

  const platform = (await p.choice('Which messaging platform?', ['Telegram', 'Slack', 'Discord', 'Teams'])) as Platform

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

  const keys: Answers['keys'] = {}
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

  p.say('Wordsmith: delegates prose drafting to Gemini. Key: https://aistudio.google.com/app/apikey')
  skills.wordsmith = await p.yesNo('Enable Wordsmith skill?')
  if (skills.wordsmith) keys.google = await p.ask('Google API key (leave blank to fill in later)', '')

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
