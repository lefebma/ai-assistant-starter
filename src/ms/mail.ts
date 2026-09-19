/**
 * Outlook mail through Graph.
 *
 * The send/draft split is the same rule Gmail follows here: a draft lands in
 * the mailbox and costs one click, a send cannot be recalled. So sendDraft
 * takes an explicit approval argument and refuses without it, rather than
 * leaving "did the owner actually agree to this" to the caller's memory.
 */
import { utcToLocal } from './time.js'

export interface GraphLike {
  get(path: string, headers?: Record<string, string>): Promise<unknown>
  post(path: string, body: unknown): Promise<unknown>
  patch(path: string, body: unknown): Promise<unknown>
}

export interface MailSummary {
  id: string
  subject: string
  /** "Name <address>", or "unknown" when Graph returns neither. */
  from: string
  received: string
  unread: boolean
  preview: string
}

export interface MailBody extends MailSummary {
  body: string
}

export interface DraftInput {
  to: string[]
  subject: string
  body: string
  /** Plain text by default: an HTML body renders markdown asterisks literally. */
  html?: boolean
}

/** Graph rejects a huge $top, and a wide search should not drain a mailbox. */
const MAX_RESULTS = 50

const SELECT = 'id,subject,from,receivedDateTime,isRead,bodyPreview'

interface RawMessage {
  id?: string
  subject?: string
  from?: { emailAddress?: { name?: string; address?: string } }
  receivedDateTime?: string
  isRead?: boolean
  bodyPreview?: string
  body?: { content?: string }
}

function sender(m: RawMessage): string {
  const e = m.from?.emailAddress
  if (!e?.address && !e?.name) return 'unknown'
  return e.name ? `${e.name} <${e.address ?? ''}>` : (e.address ?? 'unknown')
}

function toSummary(m: RawMessage): MailSummary {
  return {
    id: m.id ?? '',
    subject: m.subject ?? '(no subject)',
    from: sender(m),
    received: m.receivedDateTime ?? '',
    unread: m.isRead === false,
    preview: m.bodyPreview ?? '',
  }
}

export async function searchMail(client: GraphLike, query: string, count = 10): Promise<MailSummary[]> {
  const top = Math.min(Math.max(1, count), MAX_RESULTS)
  const path = `/me/messages?$search=${encodeURIComponent(`"${query}"`)}&$top=${top}&$select=${SELECT}`
  const res = (await client.get(path)) as { value?: RawMessage[] }
  return (res.value ?? []).map(toSummary)
}

/** Newest first. $search cannot sort, so "what came in" needs its own call. */
export async function listInbox(client: GraphLike, count = 10): Promise<MailSummary[]> {
  const top = Math.min(Math.max(1, count), MAX_RESULTS)
  const path = `/me/mailFolders/inbox/messages?$top=${top}&$select=${SELECT}&$orderby=receivedDateTime desc`
  const res = (await client.get(path)) as { value?: RawMessage[] }
  return (res.value ?? []).map(toSummary)
}

/**
 * Marketing mail pads its preview line with invisible characters (combining
 * grapheme joiners, zero-width spaces, byte-order marks) so the inbox shows
 * only the teaser. Read as plain text, that is several lines of nothing that
 * a reader has to scroll past and a model has to pay for.
 */
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFEFF\uFFA0]/g

export function cleanBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Bodies come back as HTML unless asked otherwise, and a marketing email's
 * HTML is mostly table markup. Plain text is what a reader, human or model,
 * can use.
 */
export async function readMail(client: GraphLike, id: string): Promise<MailBody> {
  const m = (await client.get(`/me/messages/${encodeURIComponent(id)}`, {
    Prefer: 'outlook.body-content-type="text"',
  })) as RawMessage
  return { ...toSummary(m), body: cleanBody(m.body?.content ?? '') }
}

function recipients(addresses: string[]): { emailAddress: { address: string } }[] {
  return addresses.filter((a) => a.trim()).map((a) => ({ emailAddress: { address: a.trim() } }))
}

function messagePayload(input: DraftInput): Record<string, unknown> {
  return {
    subject: input.subject,
    body: { contentType: input.html ? 'HTML' : 'Text', content: input.body },
    toRecipients: recipients(input.to),
  }
}

/** Creates a draft in the mailbox. Nothing leaves until someone clicks send. */
export async function draftMail(client: GraphLike, input: DraftInput): Promise<{ id: string }> {
  const res = (await client.post('/me/messages', messagePayload(input))) as { id?: string }
  return { id: res.id ?? '' }
}

/**
 * A reply saved as a draft in the thread, quoting the original the way
 * Outlook does. `all` answers everyone on the message, not just the sender.
 */
export async function replyDraft(
  client: GraphLike,
  id: string,
  body: string,
  all = false
): Promise<{ id: string }> {
  const action = all ? 'createReplyAll' : 'createReply'
  const res = (await client.post(`/me/messages/${encodeURIComponent(id)}/${action}`, { comment: body })) as {
    id?: string
  }
  return { id: res.id ?? '' }
}

/**
 * Sends a draft that already exists. Sending by draft id rather than from
 * fresh text means what leaves is exactly what the owner looked at, not a
 * second rendering of it. `approved` is not a formality: this is the one call
 * in the module with no undo, so it has to be said out loud at the call site.
 */
export async function sendDraft(client: GraphLike, id: string, approved: boolean): Promise<void> {
  if (!approved) {
    throw new Error('send refused: sending needs explicit approval from the owner. The draft is still there.')
  }
  if (!id.trim()) throw new Error('send refused: no draft id.')
  await client.post(`/me/messages/${encodeURIComponent(id)}/send`, {})
}

/** A readable rendering for a chat window, times in the owner's zone. */
export function summarise(messages: MailSummary[], timeZone = 'UTC'): string {
  if (messages.length === 0) return 'No messages matched.'
  return messages
    .map((m) => {
      const mark = m.unread ? '* ' : '  '
      const when = m.received ? utcToLocal(m.received, timeZone).slice(0, 16).replace('T', ' ') : ''
      return `${mark}${m.subject}\n    from ${m.from}${when ? `  ${when}` : ''}\n    id ${m.id}`
    })
    .join('\n')
}
