/**
 * The real network side of the IMAP skill: ImapFlow for reading and filing,
 * nodemailer for sending. Kept thin, because none of it can be tested without
 * a live mailbox; the behaviour worth testing is in mail.ts.
 *
 * One connection per command. These commands run once per chat turn and exit,
 * so a pooled, long-lived IMAP session would only add a way to leak one.
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Envelope, MailboxLike, SenderLike } from './mail.js'
import type { ImapAccount } from './store.js'
import { markNotSent } from '../assurance/not-sent.js'

/** A server that does not answer in this long is down, not slow. */
const TIMEOUT_MS = 20_000

export interface Connection {
  mailbox: MailboxLike
  sender: SenderLike
  close(): Promise<void>
}

function login(account: ImapAccount): string {
  return account.user || account.address
}

function addressOf(a: { name?: string; address?: string } | undefined): string {
  if (!a) return ''
  return a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')
}

/**
 * What the provider calls its server for the error, for the owner. ImapFlow
 * puts the server's own words on `responseText`, and those are the useful
 * part ("Invalid credentials", "Please use an app password").
 */
export function describeError(err: unknown, account: ImapAccount): string {
  const e = err as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string }
  if (e?.authenticationFailed || /auth|credential|password|login/i.test(e?.responseText ?? '')) {
    return (
      `${account.provider} refused the sign-in for ${account.address}` +
      `${e.responseText ? ` ("${e.responseText}")` : ''}. ` +
      `It needs an app password, not the account password; make a new one and store it again.`
    )
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT') {
    return `Could not reach ${account.imap.host} (${e.code}). Check the server name, or try again shortly.`
  }
  return e?.responseText || e?.message || String(err)
}

async function envelopes(client: ImapFlow, uids: number[]): Promise<Envelope[]> {
  if (uids.length === 0) return []
  const out: Envelope[] = []
  for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
    const date = m.envelope?.date ?? m.internalDate
    out.push({
      uid: m.uid,
      subject: m.envelope?.subject ?? '',
      from: addressOf(m.envelope?.from?.[0]),
      date: date ? new Date(date).toISOString() : '',
      unread: !m.flags?.has('\\Seen'),
    })
  }
  return out.sort((a, b) => b.uid - a.uid)
}

export async function connect(account: ImapAccount, password: string): Promise<Connection> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    doSTARTTLS: account.imap.secure ? undefined : true,
    auth: { user: login(account), pass: password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 3,
  })
  // An idle socket error after a command has finished must not crash the process.
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (err) {
    throw new Error(describeError(err, account))
  }

  let specialUse: Map<string, string> | null = null
  const folderFor = async (use: 'drafts' | 'sent'): Promise<string | null> => {
    if (!specialUse) {
      specialUse = new Map()
      for (const f of await client.list()) if (f.specialUse) specialUse.set(f.specialUse, f.path)
    }
    return specialUse.get(use === 'drafts' ? '\\Drafts' : '\\Sent') ?? null
  }

  const withFolder = async <T>(folder: string, fn: () => Promise<T>): Promise<T> => {
    const lock = await client.getMailboxLock(folder)
    try {
      return await fn()
    } finally {
      lock.release()
    }
  }

  const mailbox: MailboxLike = {
    folderFor,
    recent: (folder, count) =>
      withFolder(folder, async () => {
        const all = (await client.search({ all: true }, { uid: true })) || []
        return envelopes(client, all.slice(-count))
      }),
    search: (folder, query, count) =>
      withFolder(folder, async () => {
        const hits = (await client.search({ or: [{ subject: query }, { from: query }, { text: query }] }, { uid: true })) || []
        return envelopes(client, hits.slice(-count))
      }),
    source: (folder, uid) =>
      withFolder(folder, async () => {
        const m = await client.fetchOne(String(uid), { source: true }, { uid: true })
        return m && m.source ? m.source : null
      }),
    append: async (folder, raw, flags) => {
      const res = await client.append(folder, raw, flags)
      return res && typeof res.uid === 'number' ? res.uid : null
    },
    remove: (folder, uid) =>
      withFolder(folder, async () => {
        await client.messageDelete(String(uid), { uid: true })
      }),
  }

  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    // Without this, a STARTTLS port that fails to upgrade sends in the clear.
    requireTLS: !account.smtp.secure,
    auth: { user: login(account), pass: password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 3,
  })

  const sender: SenderLike = {
    send: async (raw, envelope) => {
      try {
        await transport.sendMail({ envelope, raw })
      } catch (err) {
        const e = new Error(`${account.provider} did not accept the message for sending: ${describeError(err, account)}`)
        // An SMTP reply code means the server answered and refused, so nothing
        // went out. A dropped connection or timeout has none (card #229).
        throw typeof (err as { responseCode?: unknown })?.responseCode === 'number' ? markNotSent(e) : e
      }
    },
  }

  return {
    mailbox,
    sender,
    close: async () => {
      transport.close()
      await client.logout().catch(() => {})
    },
  }
}

/**
 * Proves both halves work before anything is saved: an IMAP sign-in and an
 * SMTP sign-in. Some providers accept one and refuse the other (SMTP off on
 * the account, or an app password scoped to IMAP only).
 */
export async function verifyAccount(account: ImapAccount, password: string): Promise<void> {
  const conn = await connect(account, password)
  try {
    await conn.mailbox.folderFor('drafts')
  } finally {
    await conn.close()
  }
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    requireTLS: !account.smtp.secure,
    auth: { user: login(account), pass: password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
  })
  try {
    await transport.verify()
  } catch (err) {
    throw new Error(`Reading mail works, but sending does not: ${describeError(err, account)}`)
  } finally {
    transport.close()
  }
}
