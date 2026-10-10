/**
 * The two commands the IMAP skill calls: imap-auth and imap-mail.
 *
 * Same shape as src/ms/cli.ts: behaviour here, with the world passed in, and
 * scripts/imap-*.ts only wire in the real network and vault. Each command
 * returns the text to print, and errors carry a message meant for the owner,
 * because the assistant relays them as they are.
 */
import { parseArgs } from 'node:util'
import { installTimezone } from '../env.js'
import { defaultVault } from '../vault/index.js'
import { summarise } from '../ms/mail.js'
import { utcToLocal } from '../ms/time.js'
import { connect, verifyAccount, type Connection } from './client.js'
import { draftMail, listInbox, readMail, replyDraft, searchMail, sendDraft } from './mail.js'
import { isRedirect, presetFor, PRESET_PROVIDERS, type ImapPreset } from './presets.js'
import {
  listAccounts,
  loadAccount,
  loadPassword,
  passwordSecretName,
  removeAccount,
  saveAccount,
  savePassword,
  type ImapAccount,
  type ImapVault,
} from './store.js'

/** A message body past this is cut, not dumped whole into a chat turn. */
const MAX_BODY_CHARS = 20_000

export interface ImapCliDeps {
  vault: ImapVault
  timeZone: string
  connect: (account: ImapAccount, password: string) => Promise<Connection>
  verify: (account: ImapAccount, password: string) => Promise<void>
  readStdin: () => Promise<string>
}

type Flags = Record<string, string | boolean | undefined>

function parse(argv: string[], extra: Record<string, 'string' | 'boolean'>) {
  const options: Record<string, { type: 'string' | 'boolean' }> = { account: { type: 'string' } }
  for (const [name, type] of Object.entries(extra)) options[name] = { type }
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  const [cmd = '', ...args] = positionals
  return { cmd, args, flags: values as Flags }
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function list(flags: Flags, name: string): string[] {
  return (str(flags, name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function port(flags: Flags, name: string): number | undefined {
  const raw = str(flags, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--${name} takes a port number, got "${raw}".`)
  return n
}

function count(flags: Flags, fallback: number): number {
  const raw = str(flags, 'count')
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count takes a whole number, got "${raw}".`)
  return n
}

function usageOr(cmd: string, usage: string): string {
  if (cmd === '' || cmd === 'help') return usage
  throw new Error(`Unknown command "${cmd}".\n${usage}`)
}

function looksLikeAddress(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

// ---------------------------------------------------------------- imap-auth

export const AUTH_USAGE = `usage: imap-auth <command> --account ADDRESS
  add [--password-stdin]           check the sign-in and connect the mailbox
      [--imap-host H --imap-port N --smtp-host H --smtp-port N --user U]
                                   (server settings only for providers without a preset)
  status [--check]                 connected mailboxes; --check signs in to each
  remove                           forget a mailbox and its app password
Presets: ${PRESET_PROVIDERS.join(', ')}. The app password can come from /secret set
(see what add prints) or from stdin with --password-stdin.`

/** The servers for an address: the preset, overridden by any flag given. */
function settingsFor(address: string, flags: Flags): ImapAccount {
  const preset = presetFor(address)
  if (isRedirect(preset)) throw new Error(preset.message)
  const imapHost = str(flags, 'imap-host')
  const smtpHost = str(flags, 'smtp-host')
  if (!preset && (!imapHost || !smtpHost)) {
    throw new Error(
      `There is no preset for ${address}'s provider. Give its servers: ` +
        `--imap-host and --smtp-host (and --imap-port / --smtp-port if they are not 993 and 465). ` +
        `The provider's help pages list them under "IMAP settings".`
    )
  }
  const base: ImapPreset = preset ?? {
    provider: 'IMAP',
    imap: { host: imapHost!, port: 993, secure: true },
    smtp: { host: smtpHost!, port: 465, secure: true },
    savesSent: false,
    appPasswordHelp: "Make an app password in the provider's account security settings.",
  }
  const imapPort = port(flags, 'imap-port') ?? base.imap.port
  const smtpPort = port(flags, 'smtp-port') ?? base.smtp.port
  const user = str(flags, 'user')
  return {
    address,
    provider: base.provider,
    imap: { host: imapHost ?? base.imap.host, port: imapPort, secure: imapPort === 993 ? true : imapPort === 143 ? false : base.imap.secure },
    smtp: { host: smtpHost ?? base.smtp.host, port: smtpPort, secure: smtpPort === 465 ? true : smtpPort === 587 ? false : base.smtp.secure },
    savesSent: base.savesSent,
    ...(user ? { user } : {}),
  }
}

function howToStorePassword(address: string): string {
  const preset = presetFor(address)
  const help = preset && !isRedirect(preset) ? preset.appPasswordHelp : "Make an app password in the provider's account security settings."
  const name = passwordSecretName(address)
  return [
    `${address} needs an app password before it can be connected. Nothing has been saved yet.`,
    '',
    `1. ${help}`,
    `2. In this chat, send: /secret set ${name}`,
    '   then paste the app password as your next message. It goes straight into the encrypted',
    '   vault, the assistant never sees it, and the message is deleted from the chat.',
    `3. Then ask to connect ${address} again.`,
  ].join('\n')
}

async function addAccount(address: string, flags: Flags, deps: ImapCliDeps): Promise<string> {
  const account = settingsFor(address, flags)
  if (flags['password-stdin'] === true) {
    const pw = (await deps.readStdin()).trim()
    if (!pw) throw new Error('--password-stdin was given, but nothing came in on stdin.')
    savePassword(address, pw, deps.vault)
  }
  const password = loadPassword(address, deps.vault)
  if (!password) return howToStorePassword(address)
  await deps.verify(account, password)
  saveAccount(account, deps.vault)
  return `Connected ${address} (${account.provider}). Reading and sending both work.`
}

async function status(only: string | undefined, check: boolean, deps: ImapCliDeps): Promise<string> {
  const accounts = only ? [loadAccount(only, deps.vault)].filter((a): a is ImapAccount => !!a) : listAccounts(deps.vault)
  if (accounts.length === 0) {
    return only ? `${only} is not connected. Run: imap-auth add --account ${only}` : 'No IMAP mailbox is connected.'
  }
  const lines: string[] = []
  for (const a of accounts) {
    if (!check) {
      lines.push(`${a.address}: connected (${a.provider}, ${a.imap.host})`)
      continue
    }
    const pw = loadPassword(a.address, deps.vault)
    if (!pw) {
      lines.push(`${a.address}: its app password is missing from the vault. ${howToStorePassword(a.address).split('\n')[0]}`)
      continue
    }
    try {
      await deps.verify(a, pw)
      lines.push(`${a.address}: connected and working (${a.provider})`)
    } catch (err) {
      lines.push(`${a.address}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lines.join('\n')
}

export async function runImapAuth(argv: string[], deps: ImapCliDeps): Promise<string> {
  const { cmd, flags } = parse(argv, {
    'password-stdin': 'boolean',
    'imap-host': 'string',
    'imap-port': 'string',
    'smtp-host': 'string',
    'smtp-port': 'string',
    user: 'string',
    check: 'boolean',
  })
  const address = str(flags, 'account')
  const needAddress = (): string => {
    if (!address) throw new Error(`${cmd} needs --account with the email address.\n${AUTH_USAGE}`)
    if (!looksLikeAddress(address)) throw new Error(`"${address}" does not look like an email address.`)
    return address
  }
  switch (cmd) {
    case 'add':
      return addAccount(needAddress(), flags, deps)
    case 'status':
      return status(address, flags['check'] === true, deps)
    case 'remove': {
      const a = needAddress()
      return removeAccount(a, deps.vault)
        ? `Removed ${a} and its app password. Revoke the app password at the provider too, if it is no longer needed.`
        : `${a} was not connected.`
    }
    default:
      return usageOr(cmd, AUTH_USAGE)
  }
}

// ---------------------------------------------------------------- imap-mail

export const MAIL_USAGE = `usage: imap-mail <command> [--account ADDRESS]
  inbox [--count N] [--folder F]             newest first
  search QUERY [--count N] [--folder F]      subject, sender or text
  read ID
  draft --to A[,B] [--cc C] --subject S --body B [--html]
  reply ID --body B [--all]                  saved as a draft in the thread
  send DRAFT_ID --approved                   only once the owner has said yes`

const MAIL_COMMANDS = new Set(['inbox', 'search', 'read', 'draft', 'reply', 'send'])

/** --account, else the one connected mailbox. Never a guess between several. */
function accountFor(flags: Flags, deps: ImapCliDeps): ImapAccount {
  const asked = str(flags, 'account')
  const all = listAccounts(deps.vault)
  if (asked) {
    const a = loadAccount(asked, deps.vault)
    if (a) return a
    if (all.length === 0) throw new Error(`${asked} is not connected. Run: imap-auth add --account ${asked}`)
    throw new Error(
      `${asked} is not connected, but ${all.map((x) => x.address).join(', ')} ${all.length === 1 ? 'is' : 'are'}. ` +
        `Use one of those with --account, or connect ${asked} with imap-auth add.`
    )
  }
  if (all.length === 1) return all[0]!
  if (all.length === 0) throw new Error('No IMAP mailbox is connected. Run: imap-auth add --account ADDRESS')
  throw new Error(`Several mailboxes are connected (${all.map((x) => x.address).join(', ')}). Say which with --account.`)
}

async function withConnection<T>(account: ImapAccount, deps: ImapCliDeps, fn: (c: Connection) => Promise<T>): Promise<T> {
  const pw = loadPassword(account.address, deps.vault)
  if (!pw) throw new Error(howToStorePassword(account.address))
  const conn = await deps.connect(account, pw)
  try {
    return await fn(conn)
  } finally {
    await conn.close()
  }
}

export async function runImapMail(argv: string[], deps: ImapCliDeps): Promise<string> {
  const { cmd, args, flags } = parse(argv, {
    count: 'string',
    folder: 'string',
    to: 'string',
    cc: 'string',
    subject: 'string',
    body: 'string',
    html: 'boolean',
    all: 'boolean',
    approved: 'boolean',
  })
  if (!MAIL_COMMANDS.has(cmd)) return usageOr(cmd, MAIL_USAGE)
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`${cmd} needs ${what}.\n${MAIL_USAGE}`)
    return value
  }
  // Argument mistakes surface before any network call.
  if (cmd === 'search') need(args.join(' ').trim(), 'a search query')
  if (cmd === 'read' || cmd === 'reply' || cmd === 'send') need(args[0], 'a message id')
  if (cmd === 'draft') {
    if (list(flags, 'to').length === 0) need(undefined, '--to')
    need(str(flags, 'subject'), '--subject')
    need(str(flags, 'body'), '--body')
  }
  if (cmd === 'reply') need(str(flags, 'body'), '--body')

  const account = accountFor(flags, deps)
  const folder = str(flags, 'folder') ?? 'INBOX'
  return withConnection(account, deps, async ({ mailbox, sender }) => {
    switch (cmd) {
      case 'inbox':
        return summarise(await listInbox(mailbox, count(flags, 10), folder), deps.timeZone)
      case 'search':
        return summarise(await searchMail(mailbox, args.join(' '), count(flags, 10), folder), deps.timeZone)
      case 'read': {
        const m = await readMail(mailbox, args[0]!)
        const body =
          m.body.length > MAX_BODY_CHARS
            ? `${m.body.slice(0, MAX_BODY_CHARS)}\n[cut: ${m.body.length - MAX_BODY_CHARS} more characters]`
            : m.body
        return [
          `Subject: ${m.subject}`,
          `From: ${m.from}`,
          ...(m.received ? [`Received: ${utcToLocal(m.received, deps.timeZone).slice(0, 16).replace('T', ' ')}`] : []),
          `Id: ${m.id}`,
          '',
          body.trim(),
        ].join('\n')
      }
      case 'draft': {
        const d = await draftMail(mailbox, {
          from: account.address,
          to: list(flags, 'to'),
          cc: list(flags, 'cc'),
          subject: str(flags, 'subject')!,
          body: str(flags, 'body')!,
          html: flags['html'] === true,
        })
        return d.id
          ? `Draft saved (id ${d.id}). Nothing was sent.`
          : 'Draft saved in Drafts. Nothing was sent. This server does not report new ids; list the Drafts folder to find it.'
      }
      case 'reply': {
        const d = await replyDraft(mailbox, account.address, args[0]!, str(flags, 'body')!, flags['all'] === true)
        return d.id
          ? `Reply saved as a draft (id ${d.id}). Nothing was sent.`
          : 'Reply saved in Drafts. Nothing was sent. List the Drafts folder to find its id.'
      }
      case 'send': {
        const r = await sendDraft(mailbox, sender, account.address, args[0]!, flags['approved'] === true, account.savesSent)
        return `Sent to ${r.recipients.join(', ')}.`
      }
      default:
        return usageOr(cmd, MAIL_USAGE)
    }
  })
}

// ---------------------------------------------------------------- wiring

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

export function realDeps(): ImapCliDeps {
  return { vault: defaultVault(), timeZone: installTimezone(), connect, verify: verifyAccount, readStdin }
}

export function runMain(command: (argv: string[], deps: ImapCliDeps) => Promise<string>): void {
  command(process.argv.slice(2), realDeps()).then(
    (out) => process.stdout.write(`${out}\n`),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  )
}
