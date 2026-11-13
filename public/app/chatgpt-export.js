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
 *
 * A heavy user's conversations file is hundreds of megabytes once inflated,
 * so it is never held whole (card #300): it is inflated as a stream, split
 * into one conversation at a time, and only the project ones are kept, as
 * bytes, until the upload is built.
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

/** A stream's chunks, refusing past `max` bytes; a read error means a damaged entry. */
async function* chunksOf(stream, max) {
  const reader = stream.getReader()
  let total = 0
  try {
    for (;;) {
      let r
      try {
        r = await reader.read()
      } catch {
        fail('corrupt')
      }
      if (r.done) return
      total += r.value.byteLength
      if (total > max) fail('too_large')
      yield r.value
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** One entry's bytes as a stream, inflated, after checking what the directory claims. */
export async function entryStream(blob, entry) {
  if (entry.flags & 1) fail('corrupt') // encrypted
  if (entry.size > entryLimit || entry.compressed > entryLimit) fail('too_large')
  // A stored entry is its own size; a mismatch is a doctored directory.
  if (entry.method === 0 && entry.compressed !== entry.size) fail('corrupt')
  if (entry.method !== 0 && entry.method !== 8) fail('corrupt')
  const head = await bytes(blob, entry.offset, entry.offset + 30)
  if (head.byteLength < 30 || u32(head, 0) !== 0x04034b50) fail('corrupt')
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28)
  const end = start + entry.compressed
  if (end > blob.size) fail('corrupt')
  const raw = blob.slice(start, end).stream()
  return entry.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'))
}

/** One entry's bytes, inflated, refusing past the limit. Kept for tests and small entries. */
export async function readEntry(blob, entry) {
  const parts = []
  let total = 0
  for await (const c of chunksOf(await entryStream(blob, entry), entryLimit)) {
    parts.push(c)
    total += c.byteLength
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of parts) {
    all.set(c, at)
    at += c.byteLength
  }
  return all
}

const isSpace = (ch) => ch === 32 || ch === 10 || ch === 13 || ch === 9 || ch === 0xfeff

/**
 * Split a JSON array that arrives in pieces into the text of each element, so
 * a conversations file of hundreds of megabytes is never held whole. `push`
 * takes the next piece of text and returns the elements it completed; `end`
 * checks the array closed. Throws 'not_array' for another JSON value, or
 * 'bad_json'. The server keeps
 * the same splitter in src/projects/chatgpt-export.ts.
 */
export class ArraySplitter {
  constructor() {
    this.phase = 0 // 0 before '[', 1 inside, 2 after ']'
    this.depth = 0
    this.inString = false
    this.escaped = false
    this.pieces = null
    this.afterComma = false
  }

  push(text) {
    const out = []
    let start = this.pieces ? 0 : -1
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i)
      if (this.phase === 0) {
        if (isSpace(ch)) continue
        // Another JSON value is valid but not an array; anything else is not JSON at all.
        if (ch !== 91) throw new Error(/[{"\-0-9]/.test(text[i]) ? 'not_array' : 'bad_json')
        this.phase = 1
        this.depth = 1
        continue
      }
      if (this.phase === 2) {
        if (isSpace(ch)) continue
        throw new Error('bad_json')
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === 92) this.escaped = true
        else if (ch === 34) this.inString = false
        continue
      }
      if (this.depth === 1) {
        if (isSpace(ch) && !this.pieces) continue
        if (ch === 44 || ch === 93) {
          if (this.pieces) {
            this.pieces.push(text.slice(start, i))
            out.push(this.pieces.join(''))
            this.pieces = null
            start = -1
          } else if (ch === 44 || this.afterComma) throw new Error('bad_json')
          this.afterComma = ch === 44
          if (ch === 93) {
            this.phase = 2
            this.depth = 0
          }
          continue
        }
        if (!this.pieces) {
          this.pieces = []
          start = i
        }
      }
      if (ch === 34) this.inString = true
      else if (ch === 123 || ch === 91) this.depth += 1
      else if (ch === 125 || ch === 93) {
        this.depth -= 1
        if (this.depth < 1) throw new Error('bad_json')
      }
    }
    if (this.pieces && start >= 0) this.pieces.push(text.slice(start))
    return out
  }

  end() {
    if (this.phase !== 2) throw new Error('bad_json')
  }
}

/**
 * Read one conversations file as a stream and hand each project conversation's
 * text, as bytes, to `keep`. Nothing else in the file is held past its own
 * element.
 */
async function eachProjectConversation(stream, keep) {
  const decoder = new TextDecoder()
  const split = new ArraySplitter()
  const take = (elements) => {
    for (const el of elements) {
      let c
      try {
        c = JSON.parse(el)
      } catch {
        fail('not_chatgpt')
      }
      if (isProject(c)) keep(encoder.encode(el))
    }
  }
  try {
    for await (const chunk of chunksOf(stream, entryLimit)) take(split.push(decoder.decode(chunk, { stream: true })))
    take(split.push(decoder.decode()))
    split.end()
  } catch (err) {
    if (err instanceof ExportError) throw err
    fail('not_chatgpt')
  }
}

const encoder = new TextEncoder()

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
  // Each kept conversation's text, as bytes, joined into the upload at the end.
  const kept = []
  let total = 2
  let found = 0
  const keep = (b) => {
    if (kept.length >= MAX_CONVERSATIONS) fail('too_many')
    total += b.byteLength + 1
    if (total > MAX_UPLOAD_BYTES) fail('too_large')
    kept.push(b)
  }
  for (const file of files) {
    if (await isZip(file)) {
      const entries = (await listZip(file)).filter((e) => isConversationsName(e.name))
      for (const entry of entries) {
        found += 1
        await eachProjectConversation(await entryStream(file, entry), keep)
      }
    } else if (/\.json$/i.test(file.name)) {
      if (file.size > entryLimit) fail('too_large')
      found += 1
      await eachProjectConversation(file.stream(), keep)
    }
  }
  if (!found) fail('not_chatgpt')
  if (!kept.length) fail('no_projects')
  const conversations = kept.length
  const parts = ['[']
  kept.forEach((b, i) => parts.push(i ? ',' : '', b))
  parts.push(']')
  // The Blob holds its own copy; let the pieces go before the upload starts.
  kept.length = 0
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), conversations }
}
