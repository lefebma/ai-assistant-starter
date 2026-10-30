/**
 * Recent email threads tied to one upcoming meeting: mail from, to or
 * copying any attendee in the last LOOKBACK_DAYS, in the mailbox of the
 * account the meeting is on. One search per meeting, never a whole-inbox
 * read, so the cost stays bounded by the number of meetings.
 *
 * Every field here came from someone else's email and is untrusted. It goes
 * to the model only through decide.ts, which fences it.
 *
 * No log line here carries a subject, a sender or an attendee.
 */
import { resolveGogBin } from '../infra/gog-bin.js'
import { readEnvFile } from '../env.js'
import { cleanBody, type GraphLike } from '../ms/mail.js'
import { defaultExec, type Exec } from '../email-alerts/sources.js'
import type { Attendee, UpcomingEvent } from './calendar.js'

export interface RelatedThread {
  /** Stable reference: the provider's thread or conversation id. */
  ref: string
  subject: string
  /** Newest message in the thread, ms. */
  lastAt: number
  /** The owner wrote the newest message (so the ball is in the attendee's court). */
  lastFromOwner: boolean
  /** Newest message from someone other than the owner. */
  lastInbound: { from: string; at: number; excerpt: string } | null
  messages: number
  /** Provider message ids in this thread, so a recurring meeting can skip what it already covered. */
  messageIds: string[]
  link: string
}

export const LOOKBACK_DAYS = 14
export const MAX_THREADS = 8
const MAX_SEARCH_ATTENDEES = 8
const SEARCH_LIMIT = 25
const EXCERPT_LIMIT = 700
const DAY = 86_400_000

function gogBin(): string {
  return resolveGogBin({ ...process.env, ...readEnvFile(['GOG_BIN']) })
}

/** The reply's own words: quoted history and signatures below it add cost and no signal. */
export function excerpt(body: string): string {
  const text = cleanBody(body)
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (/^>/.test(line)) break
    if (/^On .+wrote:$/i.test(line) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line) || /^From: .+/.test(line)) break
    if (/^--\s*$/.test(line)) break
    lines.push(line)
  }
  const own = lines.join('\n').trim()
  // A forward or a bare quote has no words of its own above the history; the history is the message.
  return (own || text).slice(0, EXCERPT_LIMIT)
}

function searchable(attendees: Attendee[]): string[] {
  return attendees
    .map((a) => a.email)
    .filter((e) => /^[^\s@"()]+@[^\s@"()]+$/.test(e))
    .slice(0, MAX_SEARCH_ATTENDEES)
}

// ---------- Gmail ----------

interface GogMessage {
  id?: string
  threadId?: string
  subject?: string
  from?: string
  internalDateIso?: string
  date?: string
  labels?: string[]
  body?: string
}

export function gmailQuery(emails: string[]): string {
  const terms = emails.flatMap((e) => [`from:${e}`, `to:${e}`, `cc:${e}`])
  return `newer_than:${LOOKBACK_DAYS}d -in:chats -in:drafts (${terms.join(' OR ')})`
}

export function groupGmail(rows: GogMessage[], account: string, sinceMs: number): RelatedThread[] {
  const byThread = new Map<string, GogMessage[]>()
  for (const m of rows) {
    if (!m.threadId || !m.id) continue
    if ((m.labels ?? []).map((l) => l.toUpperCase()).includes('DRAFT')) continue
    const at = Date.parse(m.internalDateIso ?? m.date ?? '')
    if (Number.isNaN(at) || at < sinceMs) continue
    const list = byThread.get(m.threadId) ?? []
    list.push(m)
    byThread.set(m.threadId, list)
  }
  const out: RelatedThread[] = []
  for (const [threadId, msgs] of byThread) {
    const timed = msgs
      .map((m) => ({ m, at: Date.parse(m.internalDateIso ?? m.date ?? '') }))
      .sort((a, b) => b.at - a.at)
    const sent = (m: GogMessage) => (m.labels ?? []).map((l) => l.toUpperCase()).includes('SENT')
    const newest = timed[0]!
    const inbound = timed.find((t) => !sent(t.m))
    out.push({
      ref: threadId,
      subject: (newest.m.subject ?? '(no subject)').trim(),
      lastAt: newest.at,
      lastFromOwner: sent(newest.m),
      lastInbound: inbound
        ? { from: (inbound.m.from ?? '').trim(), at: inbound.at, excerpt: excerpt(inbound.m.body ?? '') }
        : null,
      messages: msgs.length,
      messageIds: msgs.map((m) => m.id!),
      link: `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${threadId}`,
    })
  }
  return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_THREADS)
}

async function gmailThreads(exec: Exec, account: string, emails: string[], nowMs: number): Promise<RelatedThread[]> {
  const r = await exec(gogBin(), [
    'gmail', 'messages', 'search', gmailQuery(emails),
    '--max', String(SEARCH_LIMIT), '--include-body', '--json', '--results-only', '--account', account,
  ])
  if (!r.ok) throw new Error('gmail search failed')
  const parsed = JSON.parse(r.stdout || '[]') as GogMessage[] | { messages?: GogMessage[] }
  const rows = Array.isArray(parsed) ? parsed : (parsed.messages ?? [])
  return groupGmail(rows, account, nowMs - LOOKBACK_DAYS * DAY)
}

// ---------- Outlook ----------

interface GraphMessage {
  id?: string
  conversationId?: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  receivedDateTime?: string
  isDraft?: boolean
  webLink?: string
}

function graphFrom(m: GraphMessage): string {
  const e = m.from?.emailAddress
  if (!e) return ''
  return e.name ? `${e.name} <${e.address ?? ''}>` : (e.address ?? '')
}

/** Threads plus, for each, the id of its newest inbound message (whose body is read next). */
export function groupOutlook(
  rows: GraphMessage[],
  own: string,
  sinceMs: number
): { threads: RelatedThread[]; inboundIds: Map<string, string> } {
  const me = own.trim().toLowerCase()
  const byConv = new Map<string, { m: GraphMessage; at: number }[]>()
  for (const m of rows) {
    if (!m.id || !m.conversationId || m.isDraft) continue
    const at = Date.parse(m.receivedDateTime ?? '')
    if (Number.isNaN(at) || at < sinceMs) continue
    const list = byConv.get(m.conversationId) ?? []
    list.push({ m, at })
    byConv.set(m.conversationId, list)
  }
  const out: RelatedThread[] = []
  const inboundIds = new Map<string, string>()
  for (const [conv, list] of byConv) {
    list.sort((a, b) => b.at - a.at)
    const mine = (m: GraphMessage) => !!me && m.from?.emailAddress?.address?.toLowerCase() === me
    const newest = list[0]!
    const inbound = list.find((t) => !mine(t.m))
    if (inbound) inboundIds.set(conv, inbound.m.id!)
    out.push({
      ref: conv,
      subject: (newest.m.subject ?? '(no subject)').trim(),
      lastAt: newest.at,
      lastFromOwner: mine(newest.m),
      // The excerpt is read afterwards, for the threads that make the cut.
      lastInbound: inbound ? { from: graphFrom(inbound.m), at: inbound.at, excerpt: '' } : null,
      messages: list.length,
      messageIds: list.map((t) => t.m.id!),
      link: newest.m.webLink ?? '',
    })
  }
  return { threads: out.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_THREADS), inboundIds }
}

async function outlookThreads(client: GraphLike, own: string, emails: string[], nowMs: number): Promise<RelatedThread[]> {
  const kql = emails.map((e) => `participants:${e}`).join(' OR ')
  const path =
    `/me/messages?$search=${encodeURIComponent(`"${kql}"`)}&$top=${SEARCH_LIMIT}` +
    `&$select=id,conversationId,subject,from,receivedDateTime,isDraft,webLink`
  const res = (await client.get(path)) as { value?: GraphMessage[] }
  const { threads, inboundIds } = groupOutlook(res.value ?? [], own, nowMs - LOOKBACK_DAYS * DAY)
  // Bodies for the newest inbound message of each kept thread only.
  for (const t of threads) {
    const id = inboundIds.get(t.ref)
    if (!t.lastInbound || !id) continue
    try {
      const m = (await client.get(`/me/messages/${encodeURIComponent(id)}?$select=body`, {
        Prefer: 'outlook.body-content-type="text"',
      })) as { body?: { content?: string } }
      t.lastInbound.excerpt = excerpt(m.body?.content ?? '')
    } catch {
      t.lastInbound.excerpt = ''
    }
  }
  return threads
}

// ---------- Entry ----------

export interface ThreadDeps {
  exec?: Exec
  client?: (account: string) => GraphLike
}

/** Related threads for one meeting, newest first. Throws when the mailbox cannot be read. */
export async function relatedThreads(
  event: UpcomingEvent,
  ownAddress: string,
  nowMs: number,
  deps: ThreadDeps
): Promise<RelatedThread[]> {
  const emails = searchable(event.attendees)
  if (emails.length === 0) return []
  if (event.provider === 'google') return gmailThreads(deps.exec ?? defaultExec, event.account, emails, nowMs)
  if (!deps.client) return []
  return outlookThreads(deps.client(event.account), ownAddress, emails, nowMs)
}
