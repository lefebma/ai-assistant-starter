/**
 * Read a ChatGPT data export on the customer's computer (Import from ChatGPT,
 * Feature #282). The export is one zip of hundreds of megabytes, nearly all
 * pictures and voice recordings. Only the conversations files are opened, and
 * only the conversations that belong to ChatGPT projects are kept and sent to
 * the box. Everything else in the export stays on the computer.
 *
 * Takes the zip, or the conversations files themselves when the browser has
 * already unzipped the download. No library: the zip directory is read by
 * hand and entries are inflated with DecompressionStream.
 */

/** A conversations file larger than this, unzipped, is refused. */
export const MAX_ENTRY_BYTES = 300 * 1024 * 1024
/** The most the box accepts in one upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** The most project conversations the box takes in one import. */
export const MAX_CONVERSATIONS = 20000

let entryLimit = MAX_ENTRY_BYTES
/** Test hook: lower the per-entry limit; null restores it. */
export function setEntryLimitForTest(n) {
  entryLimit = n ?? MAX_ENTRY_BYTES
}
/** The zip directory itself; a real one is a few hundred kilobytes. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024

const CONVERSATIONS = /^(?:[^/]+\/)?conversations(?:-\d+)?\.json$/

/** An error the page can explain: code is not_chatgpt, no_projects, too_many, too_large or corrupt. */
export class ExportError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const fail = (code) => {
  throw new ExportError(code)
}

/** A conversations file's name, at the top of the zip or one folder down; never a Mac companion. */
export function isConversationsName(name) {
  if (name.startsWith('__MACOSX/')) return false
  const base = name.split('/').pop() || ''
  if (base.startsWith('._')) return false
  return CONVERSATIONS.test(name)
}

const isProject = (c) => {
  if (!c || typeof c !== 'object') return false
  const id = typeof c.conversation_template_id === 'string' ? c.conversation_template_id : typeof c.gizmo_id === 'string' ? c.gizmo_id : ''
  return id.startsWith('g-p-')
}

async function bytes(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

const u16 = (v, at) => v.getUint16(at, true)
const u32 = (v, at) => v.getUint32(at, true)
const u64 = (v, at) => {
  const n = v.getBigUint64(at, true)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('corrupt')
  return Number(n)
}

/** Where the zip's directory is and how many entries it lists, ZIP64 included. */
async function directoryOf(blob) {
  const size = blob.size
  if (size < 22) fail('corrupt')
  const tailStart = Math.max(0, size - (65535 + 22))
  const tail = await bytes(blob, tailStart, size)
  let at = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      at = i
      break
    }
  }
  if (at < 0) fail('corrupt')
  let entries = u16(tail, at + 10)
  let dirSize = u32(tail, at + 12)
  let dirOffset = u32(tail, at + 16)
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const loc = at - 20
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) fail('corrupt')
    const recordAt = u64(tail, loc + 8)
    const rec = await bytes(blob, recordAt, recordAt + 56)
    if (rec.byteLength < 56 || u32(rec, 0) !== 0x06064b50) fail('corrupt')
    entries = u64(rec, 32)
    dirSize = u64(rec, 40)
    dirOffset = u64(rec, 48)
  }
  if (dirSize > MAX_DIRECTORY_BYTES || dirOffset + dirSize > size) fail('corrupt')
  return { entries, dirSize, dirOffset }
}

/** Every entry in the directory: name, method, flags, sizes and where its local header is. */
export async function listZip(blob) {
  const { entries, dirSize, dirOffset } = await directoryOf(blob)
  const dir = await bytes(blob, dirOffset, dirOffset + dirSize)
  const decoder = new TextDecoder()
  const out = []
  let p = 0
  for (let n = 0; n < entries; n++) {
    if (p + 46 > dir.byteLength || u32(dir, p) !== 0x02014b50) fail('corrupt')
    const flags = u16(dir, p + 8)
    const method = u16(dir, p + 10)
    let compressed = u32(dir, p + 20)
    let size = u32(dir, p + 24)
    const nameLen = u16(dir, p + 28)
    const extraLen = u16(dir, p + 30)
    const commentLen = u16(dir, p + 32)
    let offset = u32(dir, p + 42)
    const nameStart = p + 46
    if (nameStart + nameLen + extraLen > dir.byteLength) fail('corrupt')
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + nameStart, nameLen))
    // ZIP64 sizes and offset, in this order, for each field that overflowed.
    let e = nameStart + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = u16(dir, e)
      const len = u16(dir, e + 2)
      if (id === 0x0001) {
        let q = e + 4
        const end = Math.min(e + 4 + len, extraEnd)
        if (size === 0xffffffff && q + 8 <= end) (size = u64(dir, q)), (q += 8)
        if (compressed === 0xffffffff && q + 8 <= end) (compressed = u64(dir, q)), (q += 8)
        if (offset === 0xffffffff && q + 8 <= end) offset = u64(dir, q)
      }
      e += 4 + len
    }
    out.push({ name, flags, method, compressed, size, offset })
    p = extraEnd + commentLen
  }
  return out
}

/** Read a stream to the end, refusing past `max` bytes. */
async function readCapped(stream, max) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    let r
    try {
      r = await reader.read()
    } catch {
      fail('corrupt')
    }
    if (r.done) break
    total += r.value.byteLength
    if (total > max) {
      reader.cancel().catch(() => {})
      fail('too_large')
    }
    chunks.push(r.value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return all
}

/** One entry's bytes, inflated. */
export async function readEntry(blob, entry) {
  if (entry.flags & 1) fail('corrupt') // encrypted
  if (entry.size > entryLimit || entry.compressed > entryLimit) fail('too_large')
  // A stored entry is its own size; a mismatch is a doctored directory.
  if (entry.method === 0 && entry.compressed !== entry.size) fail('corrupt')
  const head = await bytes(blob, entry.offset, entry.offset + 30)
  if (head.byteLength < 30 || u32(head, 0) !== 0x04034b50) fail('corrupt')
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28)
  const end = start + entry.compressed
  if (end > blob.size) fail('corrupt')
  const raw = blob.slice(start, end)
  if (entry.method === 0) return new Uint8Array(await raw.arrayBuffer())
  if (entry.method !== 8) fail('corrupt')
  return readCapped(raw.stream().pipeThrough(new DecompressionStream('deflate-raw')), entryLimit)
}

function parseConversations(buf) {
  let data
  try {
    data = JSON.parse(new TextDecoder().decode(buf).replace(/^﻿/, ''))
  } catch {
    fail('not_chatgpt')
  }
  if (!Array.isArray(data)) fail('not_chatgpt')
  return data
}

async function isZip(file) {
  if (file.size < 4) return false
  const v = await bytes(file, 0, 4)
  return u32(v, 0) === 0x04034b50 || u32(v, 0) === 0x06054b50
}

/**
 * Read the picked files: the export zip, or loose conversations files.
 * Resolves to the project conversations as one Blob ready to upload, with
 * counts for the page. Rejects with an ExportError.
 */
export async function readChatGPTExport(files) {
  const kept = []
  let found = 0
  for (const file of files) {
    if (await isZip(file)) {
      const entries = (await listZip(file)).filter((e) => isConversationsName(e.name))
      for (const entry of entries) {
        found += 1
        for (const c of parseConversations(await readEntry(file, entry))) if (isProject(c)) kept.push(c)
      }
    } else if (/\.json$/i.test(file.name)) {
      if (file.size > entryLimit) fail('too_large')
      found += 1
      for (const c of parseConversations(new Uint8Array(await file.arrayBuffer()))) if (isProject(c)) kept.push(c)
    }
  }
  if (!found) fail('not_chatgpt')
  if (!kept.length) fail('no_projects')
  if (kept.length > MAX_CONVERSATIONS) fail('too_many')
  const blob = new Blob([JSON.stringify(kept)], { type: 'application/octet-stream' })
  if (blob.size > MAX_UPLOAD_BYTES) fail('too_large')
  return { blob, conversations: kept.length }
}
