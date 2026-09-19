/**
 * The three Outlook commands the skill calls: ms-auth, ms-mail, ms-calendar.
 *
 * All of the behaviour lives here and takes its world as arguments, so it is
 * tested with no network and no vault; scripts/ms-*.ts only wire in the real
 * ones. Each command returns the text to print, and every error is thrown
 * with a message meant for the owner, because the agent relays it to them
 * as-is.
 */
import { parseArgs } from 'node:util'
import { installTimezone, readEnvFile } from '../env.js'
import { defaultVault } from '../vault/index.js'
import { pollDeviceCode, resolveMsConfig, startDeviceCode, type FetchLike } from './auth.js'
import { createEvent, eventsInRange, eventsToday, renderEvents } from './calendar.js'
import { GraphClient } from './graph.js'
import { draftMail, listInbox, readMail, replyDraft, searchMail, sendDraft, summarise } from './mail.js'
import {
  clearPending,
  clearTokens,
  listAuthedAccounts,
  loadPending,
  loadTokens,
  savePending,
  saveTokens,
  type TokenVault,
} from './store.js'
import { utcToLocal } from './time.js'

/**
 * One consent covers mail and calendar. The scripts this replaces signed in
 * once per script, so an owner with mail and calendar did device code twice
 * for the same mailbox.
 */
export const MS_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.ReadWrite',
].join(' ')

/** A message body past this is cut, not dumped whole into a chat turn. */
const MAX_BODY_CHARS = 20_000

export interface CliDeps {
  env: Record<string, string | undefined>
  timeZone: string
  vault: TokenVault
  fetchImpl: FetchLike
  /** Epoch milliseconds. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Output that has to appear before the command returns: the sign-in code. */
  print: (text: string) => void
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
  return typeof v === 'string' ? v : undefined
}

function list(flags: Flags, name: string): string[] {
  return (str(flags, name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function positiveInt(flags: Flags, name: string, fallback: number): number {
  const raw = str(flags, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} takes a whole number, got "${raw}".`)
  return n
}

/** --account, then MS_ACCOUNT, then one unnamed mailbox. */
function accountOf(flags: Flags, env: CliDeps['env']): string {
  return str(flags, 'account')?.trim() || env['MS_ACCOUNT']?.trim() || 'default'
}

function secs(deps: CliDeps): number {
  return Math.floor(deps.now() / 1000)
}

function clientFor(account: string, deps: CliDeps): GraphClient {
  return new GraphClient({
    config: resolveMsConfig(deps.env),
    account,
    scopes: MS_SCOPES,
    fetchImpl: deps.fetchImpl,
    now: () => secs(deps),
    loadTokens: (a) => loadTokens(a, deps.vault),
    saveTokens: (a, t) => saveTokens(a, t, deps.vault),
  })
}

async function whoAmI(client: GraphClient): Promise<string> {
  const me = (await client.get('/me?$select=displayName,mail,userPrincipalName')) as {
    mail?: string | null
    userPrincipalName?: string
  }
  return me.mail || me.userPrincipalName || ''
}

function usageOr(cmd: string, usage: string): string {
  if (cmd === '' || cmd === 'help') return usage
  throw new Error(`Unknown command "${cmd}".\n${usage}`)
}

// ---------------------------------------------------------------- ms-auth

export const AUTH_USAGE = `usage: ms-auth <command> [--account LABEL]
  start              show a sign-in code and return straight away
  finish [--wait S]  collect a started sign-in, waiting up to S seconds (default 60)
  login              start and finish in one go, for a terminal
  status             which accounts are connected, and as whom
  logout             forget an account's stored sign-in`

async function startSignIn(account: string, deps: CliDeps) {
  const dc = await startDeviceCode(resolveMsConfig(deps.env), MS_SCOPES, deps.fetchImpl)
  const pending = {
    deviceCode: dc.deviceCode,
    userCode: dc.userCode,
    verificationUri: dc.verificationUri,
    intervalSecs: dc.intervalSecs,
    expiresAt: secs(deps) + dc.expiresInSecs,
  }
  savePending(account, pending, deps.vault)
  return pending
}

async function finishSignIn(account: string, deps: CliDeps, waitSecs: number): Promise<string> {
  const pending = loadPending(account, deps.vault)
  if (!pending) throw new Error(`No sign-in in progress for ${account}. Run ms-auth start first.`)
  const cfg = resolveMsConfig(deps.env)
  const deadline = Math.min(secs(deps) + waitSecs, pending.expiresAt)
  for (;;) {
    if (secs(deps) >= pending.expiresAt) {
      clearPending(account, deps.vault)
      throw new Error('That sign-in code expired before it was used. Run ms-auth start for a new one.')
    }
    const r = await pollDeviceCode(cfg, pending.deviceCode, deps.fetchImpl, secs(deps))
    if (r.status === 'ok') {
      saveTokens(account, r.tokens, deps.vault)
      clearPending(account, deps.vault)
      // The sign-in stands even if this lookup fails; it only names the mailbox.
      const who = await whoAmI(clientFor(account, deps)).catch(() => '')
      return `Connected ${account}${who ? ` as ${who}` : ''}.`
    }
    if (r.status === 'failed') {
      clearPending(account, deps.vault)
      throw new Error(`Microsoft sign-in did not complete: ${r.reason}`)
    }
    if (r.slowDown) {
      pending.intervalSecs += 5
      savePending(account, pending, deps.vault)
    }
    if (secs(deps) + pending.intervalSecs > deadline) {
      return (
        `Still waiting for ${account} to finish signing in ` +
        `(code ${pending.userCode} at ${pending.verificationUri}). ` +
        `Run ms-auth finish again once that is done.`
      )
    }
    await deps.sleep(pending.intervalSecs * 1000)
  }
}

async function authStatus(accounts: string[], deps: CliDeps): Promise<string> {
  if (accounts.length === 0) return 'No Microsoft account is connected. Run ms-auth start to connect one.'
  const lines: string[] = []
  for (const a of accounts) {
    try {
      const who = await whoAmI(clientFor(a, deps))
      lines.push(`${a}: connected${who ? ` as ${who}` : ''}`)
    } catch (err) {
      lines.push(`${a}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lines.join('\n')
}

export async function runAuth(argv: string[], deps: CliDeps): Promise<string> {
  const { cmd, flags } = parse(argv, { wait: 'string' })
  const account = accountOf(flags, deps.env)
  switch (cmd) {
    case 'start': {
      const p = await startSignIn(account, deps)
      const mins = Math.max(1, Math.round((p.expiresAt - secs(deps)) / 60))
      return [
        `To connect Outlook (${account}): open ${p.verificationUri} and enter the code ${p.userCode}.`,
        `The code works for ${mins} minutes.`,
        `Once signed in: ms-auth finish --account ${account}`,
      ].join('\n')
    }
    case 'finish':
      return finishSignIn(account, deps, positiveInt(flags, 'wait', 60))
    case 'login': {
      const p = await startSignIn(account, deps)
      deps.print(`Open ${p.verificationUri} and enter the code ${p.userCode}. Waiting for the sign-in...`)
      return finishSignIn(account, deps, p.expiresAt - secs(deps))
    }
    case 'status':
      return authStatus(str(flags, 'account') ? [account] : listAuthedAccounts(deps.vault), deps)
    case 'logout': {
      const had = clearTokens(account, deps.vault)
      clearPending(account, deps.vault)
      if (!had) return `No stored sign-in for ${account}.`
      return (
        `Removed the stored sign-in for ${account}. Microsoft still lists the app as allowed on ` +
        `that account until it is removed there (My Apps for a work account, account.microsoft.com ` +
        `for a personal one).`
      )
    }
    default:
      return usageOr(cmd, AUTH_USAGE)
  }
}

// ---------------------------------------------------------------- ms-mail

export const MAIL_USAGE = `usage: ms-mail <command> [--account LABEL]
  inbox [--count N]                          newest first
  search QUERY [--count N]
  read ID
  draft --to A[,B] --subject S --body B [--html]
  reply ID --body B [--all]                  saved as a draft in the thread
  send DRAFT_ID --approved                   only once the owner has said yes`

export async function runMail(argv: string[], deps: CliDeps): Promise<string> {
  const { cmd, args, flags } = parse(argv, {
    count: 'string',
    to: 'string',
    subject: 'string',
    body: 'string',
    html: 'boolean',
    all: 'boolean',
    approved: 'boolean',
  })
  const account = accountOf(flags, deps.env)
  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`${cmd} needs ${what}.\n${MAIL_USAGE}`)
    return value
  }
  switch (cmd) {
    case 'inbox':
      return summarise(await listInbox(clientFor(account, deps), positiveInt(flags, 'count', 10)), deps.timeZone)
    case 'search': {
      const query = need(args.join(' ').trim(), 'a search query')
      const found = await searchMail(clientFor(account, deps), query, positiveInt(flags, 'count', 10))
      return summarise(found, deps.timeZone)
    }
    case 'read': {
      const m = await readMail(clientFor(account, deps), need(args[0], 'a message id'))
      const body =
        m.body.length > MAX_BODY_CHARS
          ? `${m.body.slice(0, MAX_BODY_CHARS)}\n[cut: ${m.body.length - MAX_BODY_CHARS} more characters]`
          : m.body
      return [
        `Subject: ${m.subject}`,
        `From: ${m.from}`,
        `Received: ${utcToLocal(m.received, deps.timeZone).slice(0, 16).replace('T', ' ')}`,
        `Id: ${m.id}`,
        '',
        body.trim(),
      ].join('\n')
    }
    case 'draft': {
      const to = list(flags, 'to')
      if (to.length === 0) need(undefined, '--to')
      const d = await draftMail(clientFor(account, deps), {
        to,
        subject: need(str(flags, 'subject'), '--subject'),
        body: need(str(flags, 'body'), '--body'),
        html: flags['html'] === true,
      })
      return `Draft saved (id ${d.id}). Nothing was sent.`
    }
    case 'reply': {
      const d = await replyDraft(
        clientFor(account, deps),
        need(args[0], 'the id of the message being answered'),
        need(str(flags, 'body'), '--body'),
        flags['all'] === true
      )
      return `Reply saved as a draft (id ${d.id}). Nothing was sent.`
    }
    case 'send':
      await sendDraft(clientFor(account, deps), need(args[0], 'a draft id'), flags['approved'] === true)
      return 'Sent.'
    default:
      return usageOr(cmd, MAIL_USAGE)
  }
}

// ---------------------------------------------------------------- ms-calendar

export const CALENDAR_USAGE = `usage: ms-calendar <command> [--account LABEL]
  today
  range FIRST_DAY [LAST_DAY]                 dates like 2026-09-20, both inclusive
  create --subject S --start 2026-09-20T10:00 --end 2026-09-20T11:00
         [--location L] [--body B] [--attendees A,B --approved]`

export async function runCalendar(argv: string[], deps: CliDeps): Promise<string> {
  const { cmd, args, flags } = parse(argv, {
    subject: 'string',
    start: 'string',
    end: 'string',
    location: 'string',
    body: 'string',
    attendees: 'string',
    approved: 'boolean',
  })
  const account = accountOf(flags, deps.env)
  switch (cmd) {
    case 'today':
      return renderEvents(await eventsToday(clientFor(account, deps), deps.timeZone, new Date(deps.now())))
    case 'range': {
      const first = args[0]
      if (!first) throw new Error(`range needs at least one date.\n${CALENDAR_USAGE}`)
      const last = args[1] ?? first
      const events = await eventsInRange(clientFor(account, deps), first, last, deps.timeZone)
      return renderEvents(events, last !== first)
    }
    case 'create': {
      const subject = str(flags, 'subject')
      const start = str(flags, 'start')
      const end = str(flags, 'end')
      if (!subject || !start || !end) throw new Error(`create needs --subject, --start and --end.\n${CALENDAR_USAGE}`)
      const attendees = list(flags, 'attendees')
      const e = await createEvent(clientFor(account, deps), {
        subject,
        start,
        end,
        timeZone: deps.timeZone,
        attendees,
        location: str(flags, 'location'),
        body: str(flags, 'body'),
        invitesApproved: flags['approved'] === true,
      })
      const when = `${start.slice(0, 10)} ${start.slice(11, 16)}-${end.slice(11, 16)} (${deps.timeZone})`
      const invited = attendees.length ? `, invitations sent to ${attendees.join(', ')}` : ''
      return `Created "${subject}" on ${when}${invited}. Id ${e.id}`
    }
    default:
      return usageOr(cmd, CALENDAR_USAGE)
  }
}

// ---------------------------------------------------------------- wiring

/** The real world: .env beside the install, the install's vault and zone. */
export function realDeps(): CliDeps {
  const file = readEnvFile(['MS_CLIENT_ID', 'MS_TENANT_ID', 'MS_ACCOUNT'])
  const pick = (k: string) => process.env[k]?.trim() || file[k]
  return {
    env: { MS_CLIENT_ID: pick('MS_CLIENT_ID'), MS_TENANT_ID: pick('MS_TENANT_ID'), MS_ACCOUNT: pick('MS_ACCOUNT') },
    timeZone: installTimezone(),
    vault: defaultVault(),
    fetchImpl: (url, init) => fetch(url, init) as never,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    print: (text) => process.stdout.write(`${text}\n`),
  }
}

export function runMain(command: (argv: string[], deps: CliDeps) => Promise<string>): void {
  command(process.argv.slice(2), realDeps()).then(
    (out) => process.stdout.write(`${out}\n`),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  )
}
