/**
 * ChatGPT export parser (Import from ChatGPT, Feature #282). The browser reads
 * the customer's export zip and uploads only the conversations that belong to
 * ChatGPT projects, as one JSON array (public/app/chatgpt-export.js). This
 * turns that array into projects with readable conversation transcripts.
 *
 * The upload may be hostile: every field is checked for its type, the message
 * tree is walked with a visited set and a node cap, and the counts are capped.
 * The export has no project names or instructions; the owner supplies them.
 *
 * Nothing here logs: titles and content are the customer's.
 */
import { closeSync, openSync, readSync } from 'node:fs'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** Seconds, or 0 when the export has none. */
  at: number
}

export interface ChatConversation {
  id: string
  title: string
  created: number
  updated: number
  messages: ChatMessage[]
  /** True when the thread was longer than CHAT_LIMITS.nodes and its oldest part was left out. */
  truncated?: boolean
}

export interface ChatProject {
  /** ChatGPT's project id, `g-p-...`. */
  id: string
  conversations: ChatConversation[]
}

export type ChatParseError = 'not_chatgpt' | 'no_projects' | 'too_large' | 'too_many' | 'too_many_projects'

export type ChatParseResult =
  | { ok: true; projects: ChatProject[]; unreadable: number }
  | { ok: false; code: ChatParseError }

export const CHAT_LIMITS = { conversations: 20000, projects: 1000, nodes: 20000 }

const PROJECT_ID = /^g-p-[A-Za-z0-9-]{1,100}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** Seconds since 1970. Milliseconds are taken as such; anything else out of range counts as no date. */
const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0
  const s = v > 1e11 ? v / 1000 : v
  return s > 0 && s < 1e11 ? s : 0
}

/** The text of one part of a message, or null when it carries none worth keeping. */
function partText(part: unknown): string | null {
  if (typeof part === 'string') return part
  if (!isObject(part)) return null
  const kind = str(part.content_type)
  if (kind === 'audio_transcription') return str(part.text) || null
  if (kind === 'image_asset_pointer') return '[picture]'
  return null
}

function messageOf(node: unknown): ChatMessage | null {
  if (!isObject(node) || !isObject(node.message)) return null
  const m = node.message
  const role = isObject(m.author) ? str(m.author.role) : ''
  if (role !== 'user' && role !== 'assistant') return null
  const recipient = m.recipient
  if (recipient !== undefined && recipient !== null && recipient !== 'all') return null
  const meta = isObject(m.metadata) ? m.metadata : {}
  if (meta.is_visually_hidden_from_conversation === true) return null
  const content = isObject(m.content) ? m.content : {}
  const kind = str(content.content_type)
  if (kind !== 'text' && kind !== 'multimodal_text') return null
  if (!Array.isArray(content.parts)) return null
  const text = content.parts
    .map(partText)
    .filter((t): t is string => t !== null && t.trim() !== '')
    .join('\n\n')
    .trim()
  if (!text) return null
  return { role, text, at: num(m.create_time) }
}

/** The thread ChatGPT shows: from `current_node` up to the root, oldest first. */
function threadOf(mapping: Record<string, unknown>, current: string): { messages: ChatMessage[]; truncated: boolean } {
  const out: ChatMessage[] = []
  const seen = new Set<string>()
  let id: string = current
  while (id && !seen.has(id) && seen.size < CHAT_LIMITS.nodes) {
    seen.add(id)
    const node = Object.prototype.hasOwnProperty.call(mapping, id) ? mapping[id] : undefined
    if (!isObject(node)) break
    const msg = messageOf(node)
    if (msg) out.push(msg)
    id = str(node.parent)
  }
  // Stopped at the cap with more of the thread above: say so rather than cut it silently.
  const truncated = seen.size >= CHAT_LIMITS.nodes && !!id && !seen.has(id)
  return { messages: out.reverse(), truncated }
}

function conversationOf(v: unknown): { projectId: string; conversation: ChatConversation } | null {
  if (!isObject(v)) return null
  const projectId = str(v.conversation_template_id) || str(v.gizmo_id)
  if (!PROJECT_ID.test(projectId)) return null
  const id = str(v.conversation_id) || str(v.id)
  if (!id || !isObject(v.mapping)) return null
  const { messages, truncated } = threadOf(v.mapping, str(v.current_node))
  const created = num(v.create_time) || messages.find((m) => m.at)?.at || 0
  const updated = num(v.update_time) || [...messages].reverse().find((m) => m.at)?.at || created
  return { projectId, conversation: { id, title: str(v.title).trim(), created, updated, messages, ...(truncated ? { truncated } : {}) } }
}

/** True when a value looks like one ChatGPT conversation, in or out of a project. */
const looksLikeConversation = (v: unknown): boolean => isObject(v) && isObject(v.mapping) && ('current_node' in v || 'conversation_id' in v)

/**
 * Takes the uploaded conversations one at a time, so the raw export never has
 * to be held whole (card #300). Conversations outside projects are ignored
 * (the browser leaves them out anyway); a project conversation that cannot be
 * read is counted; a conversation id seen twice is kept once.
 */
export class ChatGPTCollector {
  private readonly byProject = new Map<string, ChatConversation[]>()
  private readonly seen = new Set<string>()
  private unreadable = 0
  private count = 0
  private anyConversation = false

  /** Take one element of the array. Returns a code to stop with, or null to carry on. */
  add(item: unknown): ChatParseError | null {
    this.count += 1
    if (this.count > CHAT_LIMITS.conversations) return 'too_many'
    if (!this.anyConversation && looksLikeConversation(item)) this.anyConversation = true
    const pid = isObject(item) ? str(item.conversation_template_id) || str(item.gizmo_id) : ''
    if (!PROJECT_ID.test(pid)) return null
    const c = conversationOf(item)
    if (!c) {
      this.unreadable += 1
      return null
    }
    if (this.seen.has(c.conversation.id)) return null
    this.seen.add(c.conversation.id)
    let list = this.byProject.get(c.projectId)
    if (!list) {
      if (this.byProject.size >= CHAT_LIMITS.projects) return 'too_many_projects'
      list = []
      this.byProject.set(c.projectId, list)
    }
    list.push(c.conversation)
    return null
  }

  /** Projects newest activity first, conversations newest first within each. */
  finish(): ChatParseResult {
    if (this.count && !this.anyConversation) return { ok: false, code: 'not_chatgpt' }
    if (!this.byProject.size) return { ok: false, code: 'no_projects' }
    const projects = [...this.byProject].map(([id, conversations]) => ({
      id,
      conversations: conversations.sort((a, b) => b.updated - a.updated),
    }))
    projects.sort((a, b) => (b.conversations[0]?.updated ?? 0) - (a.conversations[0]?.updated ?? 0))
    return { ok: true, projects, unreadable: this.unreadable }
  }
}

/** Parse the uploaded array when it is already in memory. */
export function parseChatGPTConversations(data: unknown): ChatParseResult {
  if (!Array.isArray(data)) return { ok: false, code: 'not_chatgpt' }
  if (data.length > CHAT_LIMITS.conversations) return { ok: false, code: 'too_many' }
  const collector = new ChatGPTCollector()
  for (const item of data) {
    const stop = collector.add(item)
    if (stop) return { ok: false, code: stop }
  }
  return collector.finish()
}

const isSpace = (ch: number) => ch === 32 || ch === 10 || ch === 13 || ch === 9 || ch === 0xfeff

/**
 * Split a JSON array that arrives in pieces into the text of each element.
 * `push` takes the next piece and returns the elements it completed; `end`
 * checks the array closed. Throws Error('not_array') for another JSON value,
 * or Error('bad_json'). The browser keeps the same splitter in public/app/chatgpt-export.js.
 */
export class ArraySplitter {
  private phase = 0 // 0 before '[', 1 inside, 2 after ']'
  private depth = 0
  private inString = false
  private escaped = false
  private pieces: string[] | null = null
  private afterComma = false

  push(text: string): string[] {
    const out: string[] = []
    let start = this.pieces ? 0 : -1
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i)
      if (this.phase === 0) {
        if (isSpace(ch)) continue
        // Another JSON value is valid but not an array; anything else is not JSON at all.
        if (ch !== 91) throw new Error(/[{"\-0-9]/.test(text[i]!) ? 'not_array' : 'bad_json')
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

  end(): void {
    if (this.phase !== 2) throw new Error('bad_json')
  }
}

const READ_CHUNK = 1024 * 1024

/**
 * Parse an uploaded file a megabyte at a time, one conversation at a time, so
 * only the readable transcripts are kept and never the raw export (card #300).
 * 'corrupt' means the file is not valid JSON.
 */
export function parseChatGPTFile(path: string): ChatParseResult | { ok: false; code: 'corrupt' } {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK)
    const decoder = new TextDecoder('utf-8')
    const split = new ArraySplitter()
    const collector = new ChatGPTCollector()
    const take = (elements: string[]): ChatParseError | 'corrupt' | null => {
      for (const el of elements) {
        let item: unknown
        try {
          item = JSON.parse(el)
        } catch {
          return 'corrupt'
        }
        const stop = collector.add(item)
        if (stop) return stop
      }
      return null
    }
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, READ_CHUNK, null)
        const stop = take(split.push(decoder.decode(n ? buf.subarray(0, n) : new Uint8Array(0), { stream: n > 0 })))
        if (stop) return { ok: false, code: stop }
        if (!n) break
      }
      split.end()
    } catch (err) {
      return { ok: false, code: (err as Error).message === 'not_array' ? 'not_chatgpt' : 'corrupt' }
    }
    return collector.finish()
  } finally {
    closeSync(fd)
  }
}

/** `YYYY-MM-DD` in UTC, or '' for no date. */
export function dayOf(seconds: number): string {
  const d = new Date(seconds * 1000)
  return seconds && Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ''
}

export const UNTITLED_CONVERSATION = 'Untitled conversation'

/** One conversation as Markdown. */
export function transcript(c: ChatConversation): string {
  const title = c.title || UNTITLED_CONVERSATION
  const from = dayOf(c.created)
  const to = dayOf(c.updated)
  const dates = from && to && from !== to ? `Started ${from}, last message ${to}.` : from ? `${from}.` : ''
  const lines = [`# ${title}`, '', `Imported from ChatGPT.${dates ? ' ' + dates : ''}`]
  if (c.truncated) lines.push('', `This conversation is longer than ${CHAT_LIMITS.nodes.toLocaleString('en-US')} messages. Only the most recent part came across.`)
  let day = ''
  for (const m of c.messages) {
    const d = dayOf(m.at)
    if (d && d !== day) {
      lines.push('', `### ${d}`)
      day = d
    }
    lines.push('', m.role === 'user' ? '**You:**' : '**ChatGPT:**', '', m.text)
  }
  return lines.join('\n') + '\n'
}

export interface HistoryFile {
  name: string
  text: string
}

export const MAX_HISTORY_FILES = 40
export const INDEX_FILE = 'ChatGPT conversations.md'
/** The largest history file; a bigger one is split into parts. */
export const HISTORY_FILE_BYTES = 25 * 1024 * 1024

/** Characters of a file name kept for the title, so the whole name stays under 120. */
const TITLE_CHARS = 80

function fileTitle(title: string): string {
  const t = (title || UNTITLED_CONVERSATION).replace(/\s+/g, ' ').trim()
  return t.length > TITLE_CHARS ? t.slice(0, TITLE_CHARS).trimEnd() : t
}

/** Split text into pieces of at most `max` UTF-8 bytes, at a line break where one exists. */
export function splitText(text: string, max: number): string[] {
  if (Buffer.byteLength(text) <= max) return [text]
  const out: string[] = []
  let rest = text
  while (Buffer.byteLength(rest) > max) {
    // Characters are at most 4 bytes, so this many always fit.
    let cut = Math.max(1, Math.floor(max / 4))
    let lo = cut
    let hi = rest.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (Buffer.byteLength(rest.slice(0, mid)) <= max) lo = mid
      else hi = mid - 1
    }
    cut = lo
    // The break goes with the piece before it, so look one short of the cut.
    const nl = rest.lastIndexOf('\n', cut - 1)
    if (nl > cut / 2) cut = nl + 1
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

const withPart = (name: string, i: number, n: number) => (n === 1 ? name : name.replace(/\.md$/, ` part ${i + 1}.md`))

type Layout = 'conversation' | 'month' | 'year'

/** Separator between transcripts in a month or year file. */
const BETWEEN = '\n---\n\n'

/**
 * Lays out a project's history. With `withText` false only the names are
 * worked out: each transcript is built once to measure it and dropped, and a
 * file's text is built only when it is too big for one part. That keeps the
 * review, which needs only names, from holding every file at once (card #300).
 */
class HistoryPlan {
  private readonly sizes = new Map<ChatConversation, number>()

  constructor(private readonly convs: ChatConversation[], private readonly maxBytes: number) {}

  private bytesOf(c: ChatConversation): number {
    let n = this.sizes.get(c)
    if (n === undefined) {
      n = Buffer.byteLength(transcript(c))
      this.sizes.set(c, n)
    }
    return n
  }

  /** A file's parts; their text is '' when `withText` is false. */
  private parts(name: string, make: () => string, bytes: () => number, withText: boolean): HistoryFile[] {
    if (!withText && bytes() <= this.maxBytes) return [{ name, text: '' }]
    const pieces = splitText(make(), this.maxBytes)
    return pieces.map((p, i) => ({ name: withPart(name, i, pieces.length), text: withText ? p : '' }))
  }

  files(layout: Layout, withText: boolean): HistoryFile[] {
    const oldestFirst = [...this.convs].sort((a, b) => a.created - b.created)
    if (layout === 'conversation') {
      const out: HistoryFile[] = []
      for (const c of oldestFirst) {
        const day = dayOf(c.created)
        const name = `ChatGPT ${day ? day + ' ' : ''}${fileTitle(c.title)}.md`
        out.push(...this.parts(name, () => transcript(c), () => this.bytesOf(c), withText))
      }
      return out
    }
    const key = (c: ChatConversation) => (layout === 'month' ? dayOf(c.created).slice(0, 7) : dayOf(c.created).slice(0, 4))
    const groups = new Map<string, ChatConversation[]>()
    // Oldest first inside a file, so it reads in order.
    for (const c of oldestFirst) {
      const k = key(c) || 'undated'
      const g = groups.get(k)
      if (g) g.push(c)
      else groups.set(k, [c])
    }
    const files: HistoryFile[] = []
    const where = new Map<string, string>()
    for (const [k, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const name = `ChatGPT ${k}.md`
      const made = this.parts(
        name,
        () => list.map(transcript).join(BETWEEN),
        () => list.reduce((n, c) => n + this.bytesOf(c), 0) + BETWEEN.length * (list.length - 1),
        withText
      )
      files.push(...made)
      for (const c of list) where.set(c.id, made.length === 1 ? name : `${name.replace(/\.md$/, '')} (in parts)`)
    }
    let index = ''
    if (withText) {
      const lines = ['# ChatGPT conversations', '', 'Imported from ChatGPT. Each conversation, newest first, and the file that holds it.', '']
      for (const c of [...this.convs].sort((a, b) => b.updated - a.updated)) {
        lines.push(`- ${dayOf(c.created) || 'undated'}: ${(c.title || UNTITLED_CONVERSATION).replace(/\s+/g, ' ')} (${where.get(c.id)})`)
      }
      index = lines.join('\n') + '\n'
    }
    return [{ name: INDEX_FILE, text: index }, ...files]
  }

  /** One file per conversation when they fit in `slots`; otherwise per month, then per year. */
  layout(slots: number): Layout {
    if (this.files('conversation', false).length <= slots) return 'conversation'
    if (this.files('month', false).length <= slots) return 'month'
    return 'year'
  }
}

/**
 * The files a project's history becomes. One file per conversation when they
 * fit in `slots`; otherwise one per month with an index, then one per year.
 * A file over `maxBytes` is split into parts.
 */
export function historyFiles(convs: ChatConversation[], slots: number = MAX_HISTORY_FILES, maxBytes: number = HISTORY_FILE_BYTES): HistoryFile[] {
  if (!convs.length) return []
  const plan = new HistoryPlan(convs, maxBytes)
  return plan.files(plan.layout(slots), true)
}

/** The names `historyFiles` would give, without building the files. */
export function historyFileNames(convs: ChatConversation[], slots: number = MAX_HISTORY_FILES, maxBytes: number = HISTORY_FILE_BYTES): string[] {
  if (!convs.length) return []
  const plan = new HistoryPlan(convs, maxBytes)
  return plan.files(plan.layout(slots), false).map((f) => f.name)
}
