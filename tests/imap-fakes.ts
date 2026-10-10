/**
 * In-memory stand-ins for an IMAP mailbox and an SMTP sender, shared by the
 * IMAP tests. Not a test file itself (no .test. in the name), so importing it
 * does not run anyone's suite twice.
 */
import type { Envelope, MailboxLike, SenderLike } from '../src/imap/mail.js'

interface Stored {
  uid: number
  raw: Buffer
  flags: string[]
  env: Envelope
}

/** An in-memory mailbox with real RFC 5322 messages in it. */
export function fakeMailbox(opts: { drafts?: string | null; sent?: string | null; uidplus?: boolean } = {}) {
  const folders = new Map<string, Stored[]>()
  let next = 100
  const drafts = opts.drafts === undefined ? 'Draft' : opts.drafts
  const sent = opts.sent === undefined ? 'Sent' : opts.sent
  const calls: string[] = []
  const box: MailboxLike & { folders: typeof folders; calls: string[]; put(folder: string, raw: Buffer, env: Partial<Envelope>): number } = {
    folders,
    calls,
    put(folder, raw, env) {
      const uid = next++
      const list = folders.get(folder) ?? []
      list.push({ uid, raw, flags: [], env: { uid, subject: '', from: '', date: '', unread: true, ...env } })
      folders.set(folder, list)
      return uid
    },
    async folderFor(use) {
      return use === 'drafts' ? drafts : sent
    },
    async recent(folder, count) {
      calls.push(`recent ${folder} ${count}`)
      return (folders.get(folder) ?? []).map((s) => s.env).sort((a, b) => b.uid - a.uid).slice(0, count)
    },
    async search(folder, query, count) {
      calls.push(`search ${folder} ${query} ${count}`)
      return (folders.get(folder) ?? [])
        .filter((s) => s.raw.toString().toLowerCase().includes(query.toLowerCase()))
        .map((s) => s.env)
        .sort((a, b) => b.uid - a.uid)
        .slice(0, count)
    },
    async source(folder, uid) {
      return (folders.get(folder) ?? []).find((s) => s.uid === uid)?.raw ?? null
    },
    async append(folder, raw, flags) {
      calls.push(`append ${folder} ${flags.join(' ')}`)
      const uid = box.put(folder, raw, {})
      const s = folders.get(folder)!.find((x) => x.uid === uid)!
      s.flags = flags
      return opts.uidplus === false ? null : uid
    },
    async remove(folder, uid) {
      calls.push(`remove ${folder} ${uid}`)
      folders.set(folder, (folders.get(folder) ?? []).filter((s) => s.uid !== uid))
    },
  }
  return box
}

export function fakeSender(fail = false) {
  const sent: { raw: Buffer; envelope: { from: string; to: string[] } }[] = []
  const sender: SenderLike & { sent: typeof sent } = {
    sent,
    async send(raw, envelope) {
      if (fail) throw new Error('smtp down')
      sent.push({ raw, envelope })
    },
  }
  return sender
}
