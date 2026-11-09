/**
 * Import from ChatGPT (Feature #282): the page-side reader that opens the
 * export zip on the customer's computer. Runs in Node, which has Blob, File
 * and DecompressionStream like the browser.
 */
import { describe, it, expect } from 'vitest'
import { buildZip } from './zip-fixture.js'
import { conversation } from './chatgpt-fixture.js'
import { ExportError, isConversationsName, listZip, readChatGPTExport, readEntry, setEntryLimitForTest } from '../public/app/chatgpt-export.js'

const inProject = (id: string) => conversation({ id, project: 'g-p-aaaa1111', messages: [{ role: 'user', text: 'hi' }] })
const loose = (id: string) => conversation({ id, project: null, messages: [{ role: 'user', text: 'private' }] })
const file = (buf: Buffer | string, name: string) => new File([buf], name)
const uploaded = async (r: { blob: Blob }) => JSON.parse(await r.blob.text()) as Array<{ id: string }>

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ExportError)
    return (err as ExportError).code
  }
  throw new Error('expected a rejection')
}

/** Rewrite a zip's end record as ZIP64, the way a tool does for a very large export. */
function asZip64(zip: Buffer): Buffer {
  const eocdAt = zip.length - 22
  const entries = zip.readUInt16LE(eocdAt + 10)
  const dirSize = zip.readUInt32LE(eocdAt + 12)
  const dirOffset = zip.readUInt32LE(eocdAt + 16)
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeBigUInt64LE(44n, 4)
  record.writeBigUInt64LE(BigInt(entries), 24)
  record.writeBigUInt64LE(BigInt(entries), 32)
  record.writeBigUInt64LE(BigInt(dirSize), 40)
  record.writeBigUInt64LE(BigInt(dirOffset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(eocdAt), 8)
  locator.writeUInt32LE(1, 16)
  const eocd = Buffer.from(zip.subarray(eocdAt))
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([zip.subarray(0, eocdAt), record, locator, eocd])
}

describe('isConversationsName', () => {
  it('takes the conversations files at the top or one folder down, and nothing else', () => {
    for (const n of ['conversations.json', 'conversations-000.json', 'export/conversations-014.json']) expect(isConversationsName(n), n).toBe(true)
    for (const n of ['a/b/conversations.json', '__MACOSX/conversations.json', 'export/._conversations-000.json', 'shared_conversations.json', 'conversations-000.json.dat', 'group_chats.json'])
      expect(isConversationsName(n), n).toBe(false)
  })
})

describe('readChatGPTExport', () => {
  it('reads sharded conversations from the zip and keeps only project conversations', async () => {
    const zip = buildZip([
      { name: 'conversations-000.json', data: JSON.stringify([inProject('a'), loose('b')]) },
      { name: 'conversations-001.json', data: JSON.stringify([inProject('c')]), method: 0 },
      { name: 'user.json', data: '{"email":"someone@example.com"}' },
    ])
    const r = await readChatGPTExport([file(zip, 'export.zip')])
    expect(r.conversations).toBe(2)
    expect((await uploaded(r)).map((c) => c.id)).toEqual(['a', 'c'])
  })

  it('never opens an entry that is not a conversations file', async () => {
    const zip = buildZip([
      { name: 'file-abc.dat', data: Buffer.from('not deflate data at all'), method: 0 },
      { name: 'conversations.json', data: JSON.stringify([inProject('a')]) },
    ])
    // Mark the picture as deflated in both headers, so opening it would fail.
    const poisoned = Buffer.from(zip)
    const dirOffset = poisoned.readUInt32LE(poisoned.length - 22 + 16)
    poisoned.writeUInt16LE(8, dirOffset + 10)
    poisoned.writeUInt16LE(8, 8)
    const [picture] = await listZip(new Blob([poisoned]))
    expect(picture!.method).toBe(8)
    expect(await code(readEntry(new Blob([poisoned]), picture!))).toBe('corrupt')
    const r = await readChatGPTExport([file(poisoned, 'export.zip')])
    expect(r.conversations).toBe(1)
  })

  it('reads a zip that Finder made, with the folder inside it', async () => {
    const zip = buildZip([
      { name: 'chatgpt-export/conversations.json', data: JSON.stringify([inProject('a')]) },
      { name: '__MACOSX/chatgpt-export/._conversations.json', data: 'resource fork' },
    ])
    expect((await readChatGPTExport([file(zip, 'chatgpt-export.zip')])).conversations).toBe(1)
  })

  it('reads a ZIP64 end record', async () => {
    const zip = asZip64(buildZip([{ name: 'conversations-000.json', data: JSON.stringify([inProject('a')]) }]))
    expect((await readChatGPTExport([file(zip, 'big.zip')])).conversations).toBe(1)
  })

  it('reads conversations files picked loose, when the browser already unzipped the export', async () => {
    const r = await readChatGPTExport([
      file(JSON.stringify([inProject('a')]), 'conversations-000.json'),
      file(JSON.stringify([inProject('b'), loose('c')]), 'conversations-001.json'),
      file('{"theme":"dark"}', 'user_settings.txt'),
    ])
    expect((await uploaded(r)).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('explains a file that is not a ChatGPT export', async () => {
    expect(await code(readChatGPTExport([file(buildZip([{ name: 'projects/x.json', data: '{}' }]), 'projects-000.zip')]))).toBe('not_chatgpt')
    expect(await code(readChatGPTExport([file('a picture', 'photo.png')]))).toBe('not_chatgpt')
    expect(await code(readChatGPTExport([file('{"not":"a list"}', 'conversations.json')]))).toBe('not_chatgpt')
  })

  it('says when the export has no project conversations', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: JSON.stringify([loose('a')]) }])
    expect(await code(readChatGPTExport([file(zip, 'export.zip')]))).toBe('no_projects')
  })

  it('refuses a corrupt or encrypted zip', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: JSON.stringify([inProject('a')]) }])
    expect(await code(readChatGPTExport([file(zip.subarray(0, zip.length - 30), 'cut.zip')]))).toBe('corrupt')
    const locked = buildZip([{ name: 'conversations.json', data: JSON.stringify([inProject('a')]), flags: 1 }])
    expect(await code(readChatGPTExport([file(locked, 'locked.zip')]))).toBe('corrupt')
  })

  it('refuses an entry that claims or inflates to more than the limit', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: JSON.stringify([inProject('a')]), declaredSize: 400 * 1024 * 1024 }])
    expect(await code(readChatGPTExport([file(zip, 'export.zip')]))).toBe('too_large')
  })

  it('stops inflating once an entry passes the limit, whatever the zip claims', async () => {
    const data = JSON.stringify([inProject('a'), inProject('b')])
    const zip = buildZip([{ name: 'conversations.json', data, declaredSize: 10 }])
    setEntryLimitForTest(100)
    try {
      expect(await code(readChatGPTExport([file(zip, 'export.zip')]))).toBe('too_large')
    } finally {
      setEntryLimitForTest(null)
    }
  })

  it('refuses a stored entry whose sizes disagree, so a doctored directory cannot make the tab read gigabytes', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: JSON.stringify([inProject('a')]), method: 0, declaredSize: 10 }])
    expect(await code(readChatGPTExport([file(zip, 'export.zip')]))).toBe('corrupt')
  })
})
