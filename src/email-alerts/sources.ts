/**
 * Where new mail comes from: Gmail through gog, Outlook through Graph.
 *
 * Both sides give back the same small shape. The service tick lists new mail
 * every few minutes and only asks for a body when the cheap rules cannot
 * decide, so list() fetches headers only and body() is a separate call.
 *
 * Gmail search is thread-scoped (see gmail-cleanup/core.ts): a row can be an
 * older message from a thread that matched. Every row is re-checked against
 * its own date. No log line here carries a subject or a sender.
 *
 * gog notes (v0.39.1): `gog gmail read` is an alias of `thread get`, which
 * takes a thread id. Message ids from search rows go to `gog gmail raw <id>
 * --format metadata|full --json`, which dumps the Gmail API message as is
 * (payload.headers, payload.parts, internalDate).
 */
import { execFile } from 'node:child_process'
import { resolveGogBin } from '../infra/gog-bin.js'
import { parseSearchPage } from '../gmail-cleanup/core.js'
import { readEnvFile } from '../env.js'
import { GraphClient } from '../ms/graph.js'
import { cleanBody, listInbox, readMail, type GraphLike } from '../ms/mail.js'
import { resolveMsConfig } from '../ms/auth.js'
import { listAuthedAccounts, loadTokens } from '../ms/store.js'
import type { MailHeaders } from './rules.js'

export interface NewMail {
  mailbox: string
  msgId: string
  rfcMessageId: string | null
  receivedAt: number
  headers: MailHeaders
  subject: string
}

export interface Mailbox {
  id: string
  provider: 'gmail' | 'outlook'
  list(sinceMs: number): Promise<NewMail[]>
  /** Cheap reachability check: the listing call only, no per-message fetches. */
  probe?(): Promise<void>
  body(msgId: string): Promise<string>
}

export type Exec = (bin: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const DAY = 86_400_000

/** Same string the ms CLI signs in with, so a refresh never narrows the grant. */
const MS_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.ReadWrite',
].join(' ')

export const defaultExec: Exec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout ?? '') })
    })
  })

function gogBin(): string {
  return resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
}

// ---------- Gmail ----------

interface GmailHeader {
  name?: string
  value?: string
}
interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id?: string
  internalDate?: string
  payload?: GmailPart & { headers?: GmailHeader[] }
}

function parseGmailMessage(stdout: string): GmailMessage {
  const parsed = JSON.parse(stdout) as GmailMessage & { message?: GmailMessage }
  return parsed.message && !parsed.payload ? parsed.message : parsed
}

function headerMap(m: GmailMessage): Map<string, string> {
  const map = new Map<string, string>()
  for (const h of m.payload?.headers ?? []) {
    const k = (h.name ?? '').toLowerCase()
    if (k && !map.has(k)) map.set(k, (h.value ?? '').trim())
  }
  return map
}

function mailHeaders(get: (name: string) => string | undefined): MailHeaders {
  const h: MailHeaders = { from: get('from') ?? '' }
  const set = <K extends keyof MailHeaders>(k: K, v: string | undefined) => {
    if (v) (h as unknown as Record<string, string>)[k] = v
  }
  set('listUnsubscribe', get('list-unsubscribe'))
  set('listId', get('list-id'))
  set('precedence', get('precedence'))
  set('autoSubmitted', get('auto-submitted'))
  set('returnPath', get('return-path'))
  return h
}

function findPart(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null
  if (part.mimeType === mime && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8')
  }
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime)
    if (found !== null) return found
  }
  return null
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Gog prints "YYYY-MM-DD HH:MM" (or ISO). Unparseable stays in, internalDate decides later. */
function rowTime(date: string): number {
  const t = Date.parse(date.includes('T') ? date : date.replace(' ', 'T'))
  return Number.isNaN(t) ? Number.NaN : t
}

export function gmailMailbox(account: string, exec: Exec): Mailbox {
  const bin = gogBin()
  const read = async (id: string, format: 'metadata' | 'full'): Promise<GmailMessage> => {
    const r = await exec(bin, ['gmail', 'raw', id, '--format', format, '--json', '--account', account])
    if (!r.ok) throw new Error('gmail read failed')
    return parseGmailMessage(r.stdout)
  }

  return {
    id: account,
    provider: 'gmail',
    async list(sinceMs) {
      const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / DAY))
      const r = await exec(bin, [
        'gmail', 'search', `in:inbox newer_than:${days}d`, '--plain', '--max', '100', '--account', account,
      ])
      if (!r.ok) throw new Error('gmail search failed')
      const out: NewMail[] = []
      for (const row of parseSearchPage(r.stdout).rows) {
        // Row dates may be zone-less; allow a day of slack here, the exact check is internalDate below.
        const t = rowTime(row.date)
        if (!Number.isNaN(t) && t < sinceMs - DAY) continue
        let m: GmailMessage
        try {
          m = await read(row.id, 'metadata')
        } catch {
          continue // one unreadable message must not hide the rest
        }
        const received = Number(m.internalDate)
        if (!Number.isFinite(received) || received < sinceMs) continue
        const hm = headerMap(m)
        out.push({
          mailbox: account,
          msgId: row.id,
          rfcMessageId: hm.get('message-id') || null,
          receivedAt: received,
          headers: mailHeaders((n) => hm.get(n)),
          subject: hm.get('subject') ?? '',
        })
      }
      return out
    },
    async probe() {
      const r = await exec(bin, ['gmail', 'search', 'in:inbox newer_than:1d', '--plain', '--max', '1', '--account', account])
      if (!r.ok) throw new Error('gmail search failed')
    },
    async body(msgId) {
      const m = await read(msgId, 'full')
      const text = findPart(m.payload, 'text/plain') ?? htmlToText(findPart(m.payload, 'text/html') ?? '')
      return cleanBody(text)
    },
  }
}

// ---------- Outlook ----------

interface GraphHeader {
  name?: string
  value?: string
}

export function outlookMailbox(account: string, client: GraphLike): Mailbox {
  return {
    id: account,
    provider: 'outlook',
    async list(sinceMs) {
      const out: NewMail[] = []
      for (const m of await listInbox(client, 50)) {
        const received = Date.parse(m.received)
        if (Number.isNaN(received) || received < sinceMs) continue
        let extra: { internetMessageId?: string; internetMessageHeaders?: GraphHeader[] }
        try {
          extra = (await client.get(
            `/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders,internetMessageId`
          )) as typeof extra
        } catch {
          continue // one unreadable message must not hide the rest
        }
        const map = new Map<string, string>()
        for (const h of extra.internetMessageHeaders ?? []) {
          const k = (h.name ?? '').toLowerCase()
          if (k && !map.has(k)) map.set(k, (h.value ?? '').trim())
        }
        const headers = mailHeaders((n) => (n === 'from' ? m.from : map.get(n)))
        out.push({
          mailbox: account,
          msgId: m.id,
          rfcMessageId: extra.internetMessageId || null,
          receivedAt: received,
          headers,
          subject: m.subject,
        })
      }
      return out
    },
    async probe() {
      await listInbox(client, 1)
    },
    async body(msgId) {
      return cleanBody((await readMail(client, msgId)).body)
    },
  }
}

// ---------- Discovery ----------

/**
 * `gog auth list --plain` is TSV: the account first, then client, services
 * (comma separated), and dates. Columns are not pinned by position past the
 * first: a line counts when its first column is an address and any later
 * column lists gmail.
 */
function gmailAccounts(stdout: string): string[] {
  const seen: string[] = []
  for (const line of stdout.split('\n')) {
    const cols = line.split('\t')
    const acct = (cols[0] ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+$/.test(acct)) continue
    const services = cols.slice(1).some((c) => c.split(/[,\s]+/).some((s) => s.trim().toLowerCase() === 'gmail'))
    if (services && !seen.includes(acct)) seen.push(acct)
  }
  return seen
}

export interface DiscoverDeps {
  exec?: Exec
  msAccounts?: () => string[]
  /** Test seam: the Graph client for an Outlook account. */
  client?: (account: string) => GraphLike
}

function realGraph(account: string): GraphLike {
  return new GraphClient({
    config: resolveMsConfig({ ...process.env, ...readEnvFile(['MS_CLIENT_ID', 'MS_TENANT_ID']) }),
    account,
    scopes: MS_SCOPES,
    loadTokens: (a) => loadTokens(a),
  })
}

export async function discoverMailboxes(
  deps: DiscoverDeps = {}
): Promise<{ boxes: Mailbox[]; broken: { id: string; why: string }[] }> {
  const exec = deps.exec ?? defaultExec
  const msAccounts = deps.msAccounts ?? (() => listAuthedAccounts())
  const clientFor = deps.client ?? realGraph

  const candidates: Mailbox[] = []
  const auth = await exec(gogBin(), ['auth', 'list', '--plain'])
  if (auth.ok) for (const a of gmailAccounts(auth.stdout)) candidates.push(gmailMailbox(a, exec))
  for (const a of msAccounts()) candidates.push(outlookMailbox(a, clientFor(a)))

  const boxes: Mailbox[] = []
  const broken: { id: string; why: string }[] = []
  for (const box of candidates) {
    try {
      await (box.probe ? box.probe() : box.list(Date.now()))
      boxes.push(box)
    } catch {
      const name = box.provider === 'gmail' ? 'Gmail' : 'Outlook'
      broken.push({ id: box.id, why: `${name} needs reconnecting for ${box.id}.` })
    }
  }
  return { boxes, broken }
}
