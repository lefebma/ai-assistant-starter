/**
 * Reading the command word out of an incoming message.
 *
 * Command routing in bot.ts compared the whole trimmed message against
 * lowercase literals (`trimmed === '/chatid'`), while the two gates around it
 * did not: access.ts lowercases before checking the bootstrap allow-list, and
 * the non-abort patterns are /i regexes. So `/chatID` cleared access control,
 * was recognised as a read-only command, then matched no handler and fell
 * through to the model.
 *
 * That landed on the worst possible command. `/chatid` exists to be run before
 * the install is configured — it is how the owner learns the number that goes
 * in ALLOWED_CHAT_ID — so capitalising it broke the one path that has to work
 * on a fresh install, and did it silently.
 *
 * Subcommands were never the problem: the handlers already do
 * `parts[1]?.toLowerCase()`. Only the leading word needed normalising.
 */

/**
 * The leading command word, lowercased, or '' when the message is not a
 * command. Arguments are deliberately not returned: callers pass the original
 * text on to handlers so argument case (chat ids, skill names, prompts) is
 * preserved.
 */
export function commandWord(text: string): string {
  const first = text.trim().split(/\s+/, 1)[0] ?? ''
  if (!first.startsWith('/')) return ''
  // Telegram addresses commands to a named bot in group chats: `/chatid@MyBot`.
  // Without this the same message falls through to the model in a group and
  // works in a DM, which reads as the bot ignoring people at random.
  return first.split('@', 1)[0].toLowerCase()
}
