/**
 * /private (card #187): the owner's controls for the anonymizer.
 *
 *   /private                       what it does and whether it is on here
 *   /private on | off              this chat only (PRIVACY=on in .env covers every chat)
 *   /private add <name>[, alias]   keep a name on this machine; "company" or
 *                                  "person" first says which it is
 *   /private list                  the list (main chat only)
 *   /private remove <name>         take one off (main chat only)
 *
 * The list is the whole box's, so reading it or shrinking it is the main
 * chat's call: another chat could otherwise see every client's name, or
 * switch the protection off for names it never added.
 */
import { placeholderFor, type Kind } from './mask.js'
import { addAliases, addEntry, findEntry, listEntries, privacyState, removeEntry, setChatPrivacy, type ListedEntry } from './store.js'

const COMPANY_WORDS = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|group|partners|gmbh|plc|holdings|solutions|technologies|consulting|associates|agency|studio|labs|industries|enterprises|bank|university|college)\.?$/i

/** Which kind a name looks like, when the owner did not say. */
export function guessKind(name: string): Kind {
  const n = name.trim()
  if (/@/.test(n)) return 'email'
  if (/^\+?[\d\s().-]{10,}$/.test(n)) return 'phone'
  if (COMPANY_WORDS.test(n)) return 'company'
  const words = n.split(/\s+/)
  if (words.length >= 2 && words.length <= 4 && words.every((w) => /^[A-Z][\p{L}'.-]*$/u.test(w))) return 'person'
  return 'other'
}

const KIND_WORD: Record<string, Kind> = { person: 'person', people: 'person', company: 'company', client: 'company', business: 'company', email: 'email', phone: 'phone', name: 'other', other: 'other' }
const KIND_LABEL: Record<Kind, string> = { person: 'person', company: 'company', email: 'email', phone: 'phone number', other: 'name' }

export type PrivacyCommandContext = { chatId: string; primary: boolean }

const HELP_LINES = [
  '/private on (or off) for this chat',
  '/private add Acme Corporation, Acme',
  '/private add person Jane Smith',
  '/private list',
  '/private remove Acme Corporation',
]

function status(ctx: PrivacyCommandContext): string {
  const s = privacyState(ctx.chatId)
  const count = listEntries().filter((e) => e.source === 'owner').length
  const where = s.boxWide ? 'On for every chat (set in the assistant\'s settings).' : s.on ? 'On for this chat.' : 'Off for this chat.'
  return [
    `Privacy filter: ${where}`,
    '',
    'When it is on, the names and companies on your list, plus any email address or phone number, are swapped for placeholders like COMPANY_1 before anything goes to the AI service. Replies come back with the real names put back in, here on this machine. The list itself never leaves the machine.',
    '',
    `Names on the list: ${count}.`,
    '',
    ...HELP_LINES,
  ].join('\n')
}

function describe(e: ListedEntry): string {
  const also = e.aliases.length ? ` (also ${e.aliases.join(', ')})` : ''
  return `${e.value}${also} as ${placeholderFor(e)}`
}

/** The reply to `/private <arg>`. */
export function privacyCommand(ctx: PrivacyCommandContext, arg: string): string {
  const trimmed = arg.trim()
  const [sub0, ...rest] = trimmed.split(/\s+/)
  const sub = (sub0 ?? '').toLowerCase()
  const tail = trimmed.slice(sub0?.length ?? 0).trim()

  if (!sub) return status(ctx)

  if (sub === 'on' || sub === 'off') {
    const s = privacyState(ctx.chatId)
    if (s.boxWide) return 'The privacy filter is on for every chat in the assistant\'s settings, so it cannot be switched off from a chat.'
    setChatPrivacy(ctx.chatId, sub === 'on')
    if (sub === 'off') return 'Privacy filter off for this chat. Names on your list now reach the AI service as written.'
    const count = listEntries().filter((e) => e.source === 'owner').length
    return count
      ? 'Privacy filter on for this chat. Names on your list, email addresses and phone numbers stay on this machine.'
      : 'Privacy filter on for this chat. Email addresses and phone numbers stay on this machine. Add the names and companies to keep private with /private add, for example /private add Acme Corporation.'
  }

  if (sub === 'add') {
    if (!tail) return 'Add which name? For example: /private add Acme Corporation, Acme'
    let kind: Kind | undefined
    let body = tail
    const first = rest[0]?.toLowerCase().replace(/:$/, '')
    if (first && KIND_WORD[first] && rest.length > 1) {
      kind = KIND_WORD[first]
      body = tail.slice(rest[0].length).trim()
    }
    const forms = body.split(',').map((f) => f.trim()).filter(Boolean)
    if (!forms.length) return 'Add which name? For example: /private add Acme Corporation, Acme'
    if (forms.some((f) => f.length < 3)) return 'Each name needs at least 3 characters, or ordinary words would be swapped too.'
    // A quote or backslash would break tool data the name is put back into.
    if (forms.some((f) => /["\\]/.test(f))) return 'Names cannot contain double quotes or backslashes. Add the name without them.'
    // Only the name as typed, never a placeholder: another chat must not
    // learn what PERSON_3 stands for by "adding" it.
    const existing = findEntry(forms[0], { placeholders: false })
    // Outside the main chat the reply is the same whether or not the name
    // was already there, so the list cannot be probed from another chat.
    const offHint = privacyState(ctx.chatId).on ? '' : ' The filter is off in this chat: /private on turns it on.'
    if (!ctx.primary) {
      if (existing) addAliases(existing.id, forms.slice(1))
      else addEntry(kind ?? guessKind(forms[0]), forms[0], forms.slice(1))
      return `Noted: ${forms.join(', ')} will stay on this machine whenever the privacy filter is on.${offHint}`
    }
    if (existing) {
      const extra = forms.slice(1)
      if (extra.length) addAliases(existing.id, extra)
      const updated = extra.length ? listEntries().find((e) => e.id === existing.id) : existing
      return extra.length && updated ? `Updated: ${describe(updated)}.` : `${existing.value} is already on the list, as ${placeholderFor(existing)}.`
    }
    const e = addEntry(kind ?? guessKind(forms[0]), forms[0], forms.slice(1))
    return `Added ${KIND_LABEL[e.kind]}: ${describe(e)}. It stays on this machine whenever the privacy filter is on.${offHint}`
  }

  if (sub === 'list') {
    if (!ctx.primary) return 'The list can only be shown in the main chat, since it holds every chat\'s names.'
    const entries = listEntries()
    const owner = entries.filter((e) => e.source === 'owner')
    const auto = entries.length - owner.length
    if (!owner.length && !auto) return 'The list is empty. Add a name with /private add Acme Corporation.'
    return [
      owner.length ? 'Kept on this machine:' : 'No names added yet.',
      ...owner.map((e) => `- ${describe(e)}`),
      ...(auto ? ['', `Plus ${auto} email address${auto === 1 ? '' : 'es'} and phone number${auto === 1 ? '' : 's'} found in conversations.`] : []),
    ].join('\n')
  }

  if (sub === 'remove' || sub === 'delete') {
    if (!ctx.primary) return 'Names can only be removed in the main chat.'
    if (!tail) return 'Remove which name? For example: /private remove Acme Corporation'
    const e = findEntry(tail)
    if (!e) return `${tail} is not on the list.`
    removeEntry(e.id)
    return `Removed ${e.value}. From now on it reaches the AI service as written.`
  }

  return `I don't know "/private ${sub}". Try:\n${HELP_LINES.join('\n')}`
}
