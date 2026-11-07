/**
 * The /help message.
 *
 * It used to be one line per command joined with single newlines. Teams (and
 * any Markdown renderer) treats a single newline as a soft break, so the whole
 * list arrived as one run-on paragraph that nobody could scan. This is written
 * as Markdown instead: a short bold heading per group and one list item per
 * command, which every platform shows one to a line (Teams spaces list items
 * on its own, Telegram prints the dash, the web chat renders a list).
 *
 * The command is plain text, not code, so Telegram still makes it tappable.
 */
export const HELP_GROUPS: Array<{ title: string; items: Array<[command: string, what: string]> }> = [
  {
    title: 'This chat',
    items: [
      ['/newchat', 'Clear the session and start fresh (also /forget)'],
      ['/model', 'Pick the AI model for this chat'],
      ['/effort', 'Set how hard I think before answering'],
      ['/private', 'Keep client names on this machine (on/off/add/list/remove)'],
      ['/project', 'Projects with their own instructions, chats and memory (new/off/instructions/files/rename/delete)'],
      ['/memory', 'Show stored memories'],
      ['/decisions', 'Decisions you pinned for this chat (remove <n>)'],
      ['/decide', 'Pin a decision, e.g. /decide invoices: send to billing@'],
      ['/cancel', 'Stop what is running: the reply, queued messages, scheduled runs'],
      ['/steer', 'Steer me in the middle of a reply'],
      ['/tips', 'See what you have not tried yet (on/less/off/hide)'],
    ],
  },
  {
    title: 'Talk to me from anywhere',
    items: [
      ['/voice', 'Toggle voice replies'],
      ['/voice ui', 'Get your private link to the voice chat page'],
      ['/app', 'Get a sign-in link to the web app (signout)'],
      ['/shortcut', 'Talk to me from Siri and Apple Shortcuts (status/revoke)'],
    ],
  },
  {
    title: 'Connections and automation',
    items: [
      ['/connect', 'Connect Gmail or Outlook with a sign-in link'],
      ['/schedule', 'Manage scheduled tasks'],
      ['/skill', 'Manage skills (list/enable/disable/reload)'],
      ['/browser', 'Chrome CDP (start/stop/status)'],
      ['/dashboard', 'Dashboard (start/stop)'],
    ],
  },
  {
    title: 'Security and access',
    items: [
      ['/secret', 'Manage API keys in the encrypted vault (set/list/rm)'],
      ['/authorize', 'Manage multi-chat access (add/remove/list)'],
      ['/guard report [days]', 'What the tool guard caught (or would have)'],
      ['/workspace', 'Shared workspaces (join/status/sync/leave, primary only)'],
      ['/audit', 'Review how you have been using the assistant (monthly on/off)'],
    ],
  },
  {
    title: 'Help and updates',
    items: [
      ['/support', 'Draft and send a support request (confirms before sending)'],
      ['/update', 'Check for and apply updates (check/apply)'],
      ['/version', 'Show current version'],
      ['/chatid', 'Show your chat ID'],
      ['/help', 'This message'],
    ],
  },
]

export function buildHelpText(): string {
  return HELP_GROUPS.map((g) => [`**${g.title}**`, ...g.items.map(([cmd, what]) => `- ${cmd}: ${what}`)].join('\n')).join('\n\n')
}
