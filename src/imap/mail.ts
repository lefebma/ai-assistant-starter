/**
 * Mail over IMAP and SMTP: Yahoo, AOL, iCloud and anything else that takes
 * an app password.
 *
 * The rules are the Outlook module's, deliberately, so the assistant behaves
 * the same whichever mailbox it is in: drafts land in the mailbox's own Drafts
 * folder where the owner can see them, and the one call that reaches another
 * person, sendDraft, refuses without an explicit approval. A send goes out
 * from the stored draft's bytes, so what leaves is exactly what the owner was
 * shown.
 *
 * Everything that touches the network is behind MailboxLike and SenderLike,
 * so this file is tested against fakes. Parsing and composing use the real
 * libraries, which do no I/O.
 */
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import { cleanBody, type MailBody, type MailSummary } from '../ms/mail.js'

export interface Envelope {
  uid: number
  subject: string
  /** "Name <address>", or the address alone. */
  from: string
  /** ISO 8601. */
  date: string
  unread: boolean
}

export interface MailboxLike {
  /** The folder a provider marks for that use, or null when it marks none. */
  folderFor(use: 'drafts' | 'sent'): Promise<string | null>
  /** Newest first. */
  recent(folder: string, count: number): Promise<Envelope[]>
  /** Newest first. */
  search(folder: string, query: string, count: number): Promise<Envelope[]>
  source(folder: string, uid: number): Promise<Buffer | null>
  /** The new message's UID when the server reports it (UIDPLUS), else null. */
  append(folder: string, raw: Buffer, flags: string[]): Promise<number | null>
  remove(folder: string, uid: number): Promise<void>
}

export interface SenderLike {
  send(raw: Buffer, envelope: { from: string; to: string[] }): Promise<void>
}

/** A wide request should not pull a whole mailbox into a chat turn. */
export const MAX_RESULTS = 50

/**
 * Message ids are "<folder>:<uid>". A UID is only unique inside its folder,
 * and the folder is what tells a draft id from an inbox id. Folder names can
 * hold a colon, so the split is on the last one.
 */
export function makeId(folder: string, uid: number): string {
  return `${folder}:${uid}`
}

export function parseId(id: string): { folder: string; uid: number } {
  const i = id.lastIndexOf(':')
  const folder = i > 0 ? id.slice(0, i) : ''
  const uid = Number(i > 0 ? id.slice(i + 1) : '')
  if (!folder || !Number.isInteger(uid) || uid <= 0) {
    throw new Error(`"${id}" is not a message id from this mailbox. Ids look like INBOX:1234.`)
  }
  return { folder, uid }
}

function clampCount(count: number): number {
  return Math.min(Math.max(1, Math.floor(count) || 1), MAX_RESULTS)
}

function toSummary(folder: string, e: Envelope): MailSummary {
  return {
    id: makeId(folder, e.uid),
    subject: e.subject || '(no subject)',
    from: e.from || 'unknown',
    received: e.date,
    unread: e.unread,
    preview: '',
  }
}

export async function listInbox(box: MailboxLike, count = 10, folder = 'INBOX'): Promise<MailSummary[]> {
  return (await box.recent(folder, clampCount(count))).map((e) => toSummary(folder, e))
}

export async function searchMail(box: MailboxLike, query: string, count = 10, folder = 'INBOX'): Promise<MailSummary[]> {
  const q = query.trim()
  if (!q) throw new Error('search needs something to look for.')
  return (await box.search(folder, q, clampCount(count))).map((e) => toSummary(folder, e))
}

function addressText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return ''
  return (Array.isArray(a) ? a : [a]).map((x) => x.text).filter(Boolean).join(', ')
}

function addressList(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return []
  const out: string[] = []
  for (const group of Array.isArray(a) ? a : [a]) {
    for (const v of group.value) {
      if (v.address) out.push(v.address)
      for (const member of v.group ?? []) if (member.address) out.push(member.address)
    }
  }
  return out
}

/** HTML-only mail still has to read as text; mailparser derives it when it can. */
function plainText(p: ParsedMail): string {
  if (p.text) return p.text
  if (typeof p.html === 'string') return p.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  return ''
}

async function load(box: MailboxLike, id: string): Promise<{ folder: string; uid: number; raw: Buffer; parsed: ParsedMail }> {
  const { folder, uid } = parseId(id)
  const raw = await box.source(folder, uid)
  if (!raw) throw new Error(`No message ${id}. It may have been moved or deleted; list the folder again for current ids.`)
  return { folder, uid, raw, parsed: await simpleParser(raw) }
}

export async function readMail(box: MailboxLike, id: string): Promise<MailBody> {
  const { folder, uid, parsed } = await load(box, id)
  return {
    id: makeId(folder, uid),
    subject: parsed.subject || '(no subject)',
    from: addressText(parsed.from) || 'unknown',
    received: parsed.date ? parsed.date.toISOString() : '',
    unread: false,
    preview: '',
    body: cleanBody(plainText(parsed)),
  }
}

export interface DraftInput {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  html?: boolean
  inReplyTo?: string
  references?: string[]
}

/** RFC 5322 bytes for a message, built the way nodemailer would send it. */
export function compose(input: DraftInput, date = new Date()): Promise<Buffer> {
  const mail = new MailComposer({
    from: input.from,
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    subject: input.subject,
    ...(input.html ? { html: input.body } : { text: input.body }),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references?.length ? { references: input.references } : {}),
    date,
  })
  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)))
  })
}

async function draftsFolder(box: MailboxLike): Promise<string> {
  const f = await box.folderFor('drafts')
  if (!f) throw new Error('This mailbox has no Drafts folder that the server will name, so a draft has nowhere to go.')
  return f
}

/** Saved to the mailbox's Drafts folder. Nothing is sent. */
export async function draftMail(box: MailboxLike, input: DraftInput, date = new Date()): Promise<{ id: string | null }> {
  if (input.to.length === 0) throw new Error('A draft needs at least one recipient.')
  const folder = await draftsFolder(box)
  const uid = await box.append(folder, await compose(input, date), ['\\Draft', '\\Seen'])
  return { id: uid === null ? null : makeId(folder, uid) }
}

function quote(p: ParsedMail): string {
  const when = p.date ? p.date.toUTCString() : 'an earlier date'
  const who = addressText(p.from) || 'someone'
  const lines = cleanBody(plainText(p)).split('\n').map((l) => `> ${l}`)
  return `On ${when}, ${who} wrote:\n${lines.join('\n')}`
}

/**
 * A reply saved as a draft in the thread: answers Reply-To when there is one,
 * threads with In-Reply-To and References, and quotes the original below.
 * `all` keeps everyone else on the message, never the owner themselves.
 */
export async function replyDraft(
  box: MailboxLike,
  owner: string,
  id: string,
  body: string,
  all = false,
  date = new Date()
): Promise<{ id: string | null }> {
  const { parsed } = await load(box, id)
  const self = owner.toLowerCase()
  const notSelf = (a: string) => a.toLowerCase() !== self
  const primary = addressList(parsed.replyTo).length ? addressList(parsed.replyTo) : addressList(parsed.from)
  const to = primary.filter(notSelf)
  const cc = all
    ? [...addressList(parsed.to), ...addressList(parsed.cc)].filter(notSelf).filter((a) => !to.includes(a))
    : []
  if (to.length === 0) throw new Error(`${id} has no sender to reply to.`)
  const subject = /^re:/i.test(parsed.subject ?? '') ? (parsed.subject as string) : `Re: ${parsed.subject ?? ''}`.trim()
  const refs = [
    ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []),
    ...(parsed.messageId ? [parsed.messageId] : []),
  ]
  return draftMail(
    box,
    {
      from: owner,
      to,
      cc,
      subject,
      body: `${body.trim()}\n\n${quote(parsed)}`,
      ...(parsed.messageId ? { inReplyTo: parsed.messageId } : {}),
      references: refs,
    },
    date
  )
}

/**
 * Sends a stored draft, exactly as stored. `approved` has to be said at the
 * call site: this is the one call here with no undo. The envelope sender is
 * always the owner's address, whatever the draft's From says, so a draft
 * that was tampered with cannot send as someone else through this account.
 */
export async function sendDraft(
  box: MailboxLike,
  sender: SenderLike,
  owner: string,
  id: string,
  approved: boolean,
  savesSent: boolean
): Promise<{ recipients: string[] }> {
  if (!approved) {
    throw new Error('send refused: sending needs explicit approval from the owner. The draft is still there.')
  }
  const { folder, uid, raw, parsed } = await load(box, id)
  const drafts = await box.folderFor('drafts')
  if (drafts && folder !== drafts) {
    throw new Error(`send refused: ${id} is not in ${drafts}. Only a saved draft can be sent.`)
  }
  const recipients = [...addressList(parsed.to), ...addressList(parsed.cc), ...addressList(parsed.bcc)]
  if (recipients.length === 0) throw new Error(`send refused: ${id} has no recipients.`)
  await sender.send(raw, { from: owner, to: recipients })
  // The message has left. What follows is bookkeeping, and a failure in it
  // must not read as a failed send, or the owner sends it twice.
  try {
    if (!savesSent) {
      const sent = await box.folderFor('sent')
      if (sent) await box.append(sent, raw, ['\\Seen'])
    }
    await box.remove(folder, uid)
  } catch {
    // Left as a stray draft or a missing Sent copy; both are visible and harmless.
  }
  return { recipients }
}
