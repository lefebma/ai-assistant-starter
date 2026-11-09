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
}

export interface ChatProject {
  /** ChatGPT's project id, `g-p-...`. */
  id: string
  conversations: ChatConversation[]
}

export type ChatParseError = 'not_chatgpt' | 'no_projects' | 'too_large'

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
function threadOf(mapping: Record<string, unknown>, current: string): ChatMessage[] {
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
  return out.reverse()
}

function conversationOf(v: unknown): { projectId: string; conversation: ChatConversation } | null {
  if (!isObject(v)) return null
  const projectId = str(v.conversation_template_id) || str(v.gizmo_id)
  if (!PROJECT_ID.test(projectId)) return null
  const id = str(v.conversation_id) || str(v.id)
  if (!id || !isObject(v.mapping)) return null
  const messages = threadOf(v.mapping, str(v.current_node))
  const created = num(v.create_time) || messages.find((m) => m.at)?.at || 0
  const updated = num(v.update_time) || [...messages].reverse().find((m) => m.at)?.at || created
  return { projectId, conversation: { id, title: str(v.title).trim(), created, updated, messages } }
}

/** True when a value looks like one ChatGPT conversation, in or out of a project. */
const looksLikeConversation = (v: unknown): boolean => isObject(v) && isObject(v.mapping) && ('current_node' in v || 'conversation_id' in v)

/**
 * Parse the uploaded array. Conversations outside projects are ignored (the
 * browser leaves them out anyway); a project conversation that cannot be read
 * is counted. Projects come back newest activity first, conversations newest
 * first within each, and a conversation id seen twice is kept once.
 */
export function parseChatGPTConversations(data: unknown): ChatParseResult {
  if (!Array.isArray(data)) return { ok: false, code: 'not_chatgpt' }
  if (data.length > CHAT_LIMITS.conversations) return { ok: false, code: 'too_large' }
  if (data.length && !data.some(looksLikeConversation)) return { ok: false, code: 'not_chatgpt' }
  const byProject = new Map<string, ChatConversation[]>()
  const seen = new Set<string>()
  let unreadable = 0
  for (const item of data) {
    const pid = isObject(item) ? str(item.conversation_template_id) || str(item.gizmo_id) : ''
    if (!PROJECT_ID.test(pid)) continue
    const c = conversationOf(item)
    if (!c) {
      unreadable += 1
      continue
    }
    if (seen.has(c.conversation.id)) continue
    seen.add(c.conversation.id)
    let list = byProject.get(c.projectId)
    if (!list) {
      if (byProject.size >= CHAT_LIMITS.projects) return { ok: false, code: 'too_large' }
      list = []
      byProject.set(c.projectId, list)
    }
    list.push(c.conversation)
  }
  if (!byProject.size) return { ok: false, code: 'no_projects' }
  const projects = [...byProject].map(([id, conversations]) => ({
    id,
    conversations: conversations.sort((a, b) => b.updated - a.updated),
  }))
  projects.sort((a, b) => (b.conversations[0]?.updated ?? 0) - (a.conversations[0]?.updated ?? 0))
  return { ok: true, projects, unreadable }
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

function groupFiles(convs: ChatConversation[], key: (c: ChatConversation) => string, maxBytes: number): HistoryFile[] {
  const groups = new Map<string, ChatConversation[]>()
  // Oldest first inside a file, so it reads in order.
  for (const c of [...convs].sort((a, b) => a.created - b.created)) {
    const k = key(c) || 'undated'
    const g = groups.get(k)
    if (g) g.push(c)
    else groups.set(k, [c])
  }
  const files: HistoryFile[] = []
  const index: string[] = ['# ChatGPT conversations', '', 'Imported from ChatGPT. Each conversation, newest first, and the file that holds it.', '']
  const where = new Map<string, string>()
  for (const [k, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const name = `ChatGPT ${k}.md`
    const text = list.map(transcript).join('\n---\n\n')
    const parts = splitText(text, maxBytes)
    parts.forEach((p, i) => files.push({ name: withPart(name, i, parts.length), text: p }))
    for (const c of list) where.set(c.id, parts.length === 1 ? name : `${name.replace(/\.md$/, '')} (in parts)`)
  }
  for (const c of [...convs].sort((a, b) => b.updated - a.updated)) {
    index.push(`- ${dayOf(c.created) || 'undated'}: ${(c.title || UNTITLED_CONVERSATION).replace(/\s+/g, ' ')} (${where.get(c.id)})`)
  }
  return [{ name: INDEX_FILE, text: index.join('\n') + '\n' }, ...files]
}

/**
 * The files a project's history becomes. One file per conversation when they
 * fit in `slots`; otherwise one per month with an index, then one per year.
 * A file over `maxBytes` is split into parts.
 */
export function historyFiles(convs: ChatConversation[], slots: number = MAX_HISTORY_FILES, maxBytes: number = 25 * 1024 * 1024): HistoryFile[] {
  if (!convs.length) return []
  const single = (): HistoryFile[] => {
    const out: HistoryFile[] = []
    for (const c of [...convs].sort((a, b) => a.created - b.created)) {
      const day = dayOf(c.created)
      const name = `ChatGPT ${day ? day + ' ' : ''}${fileTitle(c.title)}.md`
      const parts = splitText(transcript(c), maxBytes)
      parts.forEach((p, i) => out.push({ name: withPart(name, i, parts.length), text: p }))
    }
    return out
  }
  const perConversation = single()
  if (perConversation.length <= slots) return perConversation
  const byMonth = groupFiles(convs, (c) => dayOf(c.created).slice(0, 7), maxBytes)
  if (byMonth.length <= slots) return byMonth
  return groupFiles(convs, (c) => dayOf(c.created).slice(0, 4), maxBytes)
}
