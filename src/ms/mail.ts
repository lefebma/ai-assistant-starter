/**
 * Outlook mail through Graph.
 *
 * The send/draft split is the same rule Gmail follows here: a draft lands in
 * the mailbox and costs one click, a send cannot be recalled. So sendMail
 * takes an explicit approval argument and refuses without it, rather than
 * leaving "did the owner actually agree to this" to the caller's memory.
 */

export interface GraphLike {
  get(path: string): Promise<unknown>
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

export async function readMail(client: GraphLike, id: string): Promise<MailBody> {
  const m = (await client.get(`/me/messages/${id}`)) as RawMessage
  return { ...toSummary(m), body: m.body?.content ?? '' }
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
 * Sends immediately. `approved` is not a formality: this is the one call in
 * the module with no undo, so it has to be said out loud at the call site.
 */
export async function sendMail(client: GraphLike, input: DraftInput, approved: boolean): Promise<void> {
  if (!approved) {
    throw new Error('sendMail refused: sending needs explicit approval. Create a draft instead.')
  }
  if (recipients(input.to).length === 0) {
    throw new Error('sendMail refused: no recipient.')
  }
  await client.post('/me/sendMail', { message: messagePayload(input), saveToSentItems: true })
}

/** A readable rendering for a chat window. */
export function summarise(messages: MailSummary[]): string {
  if (messages.length === 0) return 'No messages matched.'
  return messages
    .map((m) => {
      const mark = m.unread ? '* ' : '  '
      const when = m.received ? m.received.slice(0, 16).replace('T', ' ') : ''
      return `${mark}${m.subject}\n    from ${m.from}${when ? `  ${when}` : ''}\n    id ${m.id}`
    })
    .join('\n')
}
