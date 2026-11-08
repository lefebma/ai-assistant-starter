/**
 * The tips (card #273): one short suggestion each, written for a business
 * owner, not a developer. Order is priority: earlier tips are offered first.
 *
 * Adding a feature includes adding its tip. tests/tips-catalog.test.ts reads
 * CHANGELOG.md and fails when a `- **New:` line has no tip with that version
 * as `since`. Work customers never see is written `- **New for providers:`.
 *
 * A tip never turns anything on. It says how, and the owner does it.
 *
 * Every tip carries at least one way to tell it has been tried: `used`,
 * `commands` or `phrases`. Without one it would loop forever at someone
 * already using the feature.
 */
export interface TipContext {
  /** Gmail, Outlook or an IMAP mailbox is connected. */
  mail: boolean
  /** Gmail or Outlook is connected, so there is a calendar to read. */
  calendar: boolean
  gmailAccounts: number
  briefingOn: boolean
  travelOn: boolean
  timingOn: boolean
  emailAlertsOn: boolean
  scheduledTasks: number
  decisions: number
  /** Spoken replies can be produced on this box. */
  voiceReplies: boolean
  /** A project here was brought in from another assistant. */
  importedProjects: boolean
}

export interface Tip {
  id: string
  /** The version the feature shipped in; update tips are chosen by it. */
  since: string
  /** What it does, one sentence. */
  text: string
  /** One thing to try: a command, or a sentence to say. */
  tryIt: string
  /** Worth offering to this owner. Absent means always. */
  applies?: (c: TipContext) => boolean
  /** Already in use, read from the box's settings. */
  used?: (c: TipContext) => boolean
  /** Sending one of these counts as trying it. */
  commands?: string[]
  /** A message matching this counts as trying it. */
  phrases?: RegExp
}

export const TIPS: Tip[] = [
  {
    id: 'connect-mail',
    since: '1.64.0',
    text: 'I can read and draft your email and check your calendar once your account is connected.',
    tryIt: 'Send /connect gmail or /connect outlook and follow the link.',
    applies: (c) => !c.mail,
    used: (c) => c.mail,
  },
  {
    id: 'connect-calendar',
    since: '1.64.0',
    text: 'Your mail is connected but your calendar is not, so I cannot help with meetings yet.',
    tryIt: 'Send /connect gmail or /connect outlook and follow the link.',
    applies: (c) => c.mail && !c.calendar,
    used: (c) => c.calendar,
  },
  {
    id: 'meeting-briefings',
    since: '1.56.0',
    text: 'I can send you a short heads-up before a meeting, with what you and the other people have said by email. It is off until you turn it on.',
    tryIt: 'Say "turn on meeting briefings".',
    applies: (c) => c.calendar,
    used: (c) => c.briefingOn,
    phrases: /\bmeeting briefings?\b/i,
  },
  {
    id: 'email-alerts',
    since: '1.39.0',
    text: 'I can watch your inbox and message you when something critical arrives. It is off until you turn it on.',
    tryIt: 'Say "turn on email alerts".',
    applies: (c) => c.mail,
    used: (c) => c.emailAlertsOn,
    phrases: /\bemail alerts?\b/i,
  },
  {
    id: 'scheduled-tasks',
    since: '1.0.0',
    text: 'I can do a job on a schedule and send you the result, like a summary of your day each morning.',
    tryIt: 'Say "every weekday at 8, send me a summary of my day".',
    used: (c) => c.scheduledTasks > 0,
    commands: ['/schedule'],
  },
  {
    id: 'pin-decisions',
    since: '1.71.0',
    text: 'Pin a decision and I keep to it in this chat, however long the conversation gets.',
    tryIt: 'Send /decide invoices: send them to billing, not to Priya.',
    used: (c) => c.decisions > 0,
    commands: ['/decide', '/decisions'],
  },
  {
    id: 'web-app',
    since: '1.49.0',
    text: 'You also have a web app with your chats, goals and files in one place.',
    tryIt: 'Send /app for a sign-in link.',
    commands: ['/app'],
  },
  {
    id: 'travel-messages',
    since: '1.59.0',
    text: 'For a meeting at a physical address, I can tell you when to leave. It is off until you turn it on.',
    tryIt: 'Say "turn on proactive travel messages".',
    applies: (c) => c.calendar,
    used: (c) => c.travelOn,
    phrases: /\btravel messages?\b/i,
  },
  {
    id: 'timing-warnings',
    since: '1.61.0',
    text: 'I can warn you about meetings that overlap, or that leave you no time to get from one to the next. It is off until you turn it on.',
    tryIt: 'Say "turn on proactive timing warnings".',
    applies: (c) => c.calendar,
    used: (c) => c.timingOn,
    phrases: /\btiming warnings?\b/i,
  },
  {
    id: 'private-names',
    since: '1.68.0',
    text: 'Working on something sensitive? I can swap client names, email addresses and phone numbers for placeholders before anything leaves this machine.',
    tryIt: 'Send /private on, then /private add and the names to protect.',
    commands: ['/private'],
  },
  {
    id: 'cancel',
    since: '1.47.0',
    text: 'Asked for the wrong thing? You can stop me part way through.',
    tryIt: 'Send /cancel while I am working.',
    commands: ['/cancel'],
  },
  {
    id: 'steer',
    since: '1.0.0',
    text: 'You can change my direction while I am working, without starting over.',
    tryIt: 'While I am working, send /steer and what you want changed.',
    commands: ['/steer'],
  },
  {
    id: 'model',
    since: '1.65.0',
    text: 'You can choose which AI model I use in each chat.',
    tryIt: 'Send /model and tap one.',
    commands: ['/model'],
  },
  {
    id: 'effort',
    since: '1.67.0',
    text: 'You can tell me how hard to think: quick answers for small things, deeper work for hard ones.',
    tryIt: 'Send /effort and tap a level.',
    commands: ['/effort'],
  },
  {
    id: 'more-gmail',
    since: '1.66.0',
    text: 'You can connect more than one Gmail account and name the one you want each time.',
    tryIt: 'Send /connect gmail again and sign in with the other account.',
    applies: (c) => c.gmailAccounts === 1,
    used: (c) => c.gmailAccounts > 1,
  },
  {
    id: 'voice-replies',
    since: '1.0.0',
    text: 'I can answer out loud as well as in text.',
    tryIt: 'Send /voice to turn spoken replies on or off.',
    applies: (c) => c.voiceReplies,
    commands: ['/voice'],
  },
  {
    id: 'shortcuts',
    since: '1.0.0',
    text: 'You can ask me things from Siri or an Apple Shortcut, without opening the chat.',
    tryIt: 'Send /shortcut to set it up.',
    commands: ['/shortcut'],
  },
  {
    id: 'weather',
    since: '1.41.0',
    text: 'I can look up the weather for any city.',
    tryIt: 'Say "what\'s the weather in Paris?".',
    phrases: /\bweather\b/i,
  },
  {
    id: 'memory',
    since: '1.0.0',
    text: 'You can see what I have remembered from our chats.',
    tryIt: 'Send /memory.',
    commands: ['/memory'],
  },
  {
    id: 'usage-audit',
    since: '1.0.0',
    text: 'I can review how you have been using me and suggest what to try next.',
    tryIt: 'Send /audit.',
    commands: ['/audit'],
  },
  {
    id: 'support',
    since: '1.0.0',
    text: 'If something is not working, I can write up the problem and send it to support for you.',
    tryIt: 'Send /support and describe what happened.',
    commands: ['/support'],
  },
  {
    id: 'projects',
    since: '1.73.0',
    text: 'A project keeps one client or topic apart, with its own instructions and memory.',
    tryIt: 'Send /project new and a name, then /project instructions and how I should work.',
    commands: ['/project'],
  },
  {
    id: 'import-claude-projects',
    since: '1.74.0',
    text: 'Moving from Claude? You can bring your projects here, with their instructions and files.',
    tryIt: 'In the web app, choose New project, then Import from Claude.',
    used: (c) => c.importedProjects,
    phrases: /\bimport\b.*\bclaude\b/i,
  },
  {
    id: 'tips',
    since: '1.72.0',
    text: 'I now suggest things you have not tried yet, no more than a few a week. They come at a quiet moment and stop once you use the feature.',
    tryIt: 'Send /tips for the next one, /tips less for fewer, or /tips off to stop them.',
    commands: ['/tips'],
  },
]
