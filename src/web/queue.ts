/**
 * Messages the owner sent while a reply was still being written (card #250).
 *
 * Every message sent from the web chat gets a row here: 'running' when it
 * starts straight away, 'queued' when it waits behind a reply in progress.
 * Only a waiting row holds the message (its text, pastes and uploads), since
 * a reload must show it and it can still be edited. The moment it starts the
 * row is blanked down to its clientId and state, so the store never keeps a
 * copy of what was said (a key pasted for /secret, say) once the turn owns it.
 * The queue lives in the store, not the browser, so a reload shows what is
 * waiting and a server restart does not lose it. The page names each message
 * with its own id (clientId), so a retried send finds the row it already made
 * instead of sending the message twice.
 *
 * Each conversation also has a small hub: what the current turn has streamed
 * so far, and who is listening. A page that reloads, or that waits for a
 * queued message to start, follows the conversation through it.
 */
import { basename, extname } from 'node:path'
import { getDb } from '../db.js'

export type QueueState = 'queued' | 'running' | 'done'

export interface QueueItem {
  id: number
  conversationId: string
  chatId: string
  clientId: string
  text: string
  /** Upload paths as the page sent them; moved into the conversation when the turn starts. */
  attachments: string[]
  pastes: string[]
  /** For a button click: the reply whose card it answered, fixed when it was sent. */
  clickedMessageId: number | null
  state: QueueState
  createdAt: number
}

interface RawItem {
  id: number
  conversation_id: string
  chat_id: string
  client_id: string
  text: string
  attachments: string
  pastes: string
  clicked_message_id: number | null
  state: QueueState
  created_at: number
}

/** A finished row is kept this long, so a late retry of its send is still recognised. */
const KEEP_DONE_MS = 24 * 60 * 60 * 1000

let ensured: unknown = null

function db() {
  const d = getDb()
  if (ensured === d) return d
  d.exec(`
    CREATE TABLE IF NOT EXISTS web_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      pastes TEXT NOT NULL DEFAULT '[]',
      clicked_message_id INTEGER,
      state TEXT NOT NULL CHECK(state IN ('queued','running','done')),
      created_at INTEGER NOT NULL
    )
  `)
  d.exec('CREATE INDEX IF NOT EXISTS idx_web_queue_conv ON web_queue(conversation_id, state, id)')
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_web_queue_client ON web_queue(conversation_id, client_id) WHERE client_id != ''")
  ensured = d
  return d
}

function parseArr(s: string): string[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const toItem = (r: RawItem): QueueItem => ({
  id: r.id,
  conversationId: r.conversation_id,
  chatId: r.chat_id,
  clientId: r.client_id,
  text: r.text,
  attachments: parseArr(r.attachments),
  pastes: parseArr(r.pastes),
  clickedMessageId: r.clicked_message_id ?? null,
  state: r.state,
  createdAt: r.created_at,
})

export function addItem(
  input: {
    conversationId: string
    chatId: string
    clientId: string
    text: string
    attachments: string[]
    pastes: string[]
    clickedMessageId?: number | null
    /** 'done': a message answered at once outside the queue, kept only so a retry of its send is recognised. */
    state: QueueState
  },
  now: number = Date.now(),
): QueueItem {
  const d = db()
  // A message that starts at once is never written down: the turn has it.
  const keep = input.state === 'queued'
  d.prepare("DELETE FROM web_queue WHERE state = 'done' AND created_at < ?").run(now - KEEP_DONE_MS)
  const r = d
    .prepare(
      'INSERT INTO web_queue (conversation_id, chat_id, client_id, text, attachments, pastes, clicked_message_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(input.conversationId, input.chatId, input.clientId, keep ? input.text : '', JSON.stringify(keep ? input.attachments : []), JSON.stringify(keep ? input.pastes : []), input.clickedMessageId ?? null, input.state, now)
  const row = getItem(input.conversationId, Number(r.lastInsertRowid))!
  return keep ? row : { ...row, text: input.text, attachments: input.attachments, pastes: input.pastes }
}

export function getItem(conversationId: string, id: number): QueueItem | null {
  const r = db().prepare('SELECT * FROM web_queue WHERE id = ? AND conversation_id = ?').get(id, conversationId) as RawItem | undefined
  return r ? toItem(r) : null
}

/** The row an earlier send with this id made, if any. */
export function findByClientId(conversationId: string, clientId: string): QueueItem | null {
  if (!clientId) return null
  const r = db().prepare('SELECT * FROM web_queue WHERE conversation_id = ? AND client_id = ?').get(conversationId, clientId) as RawItem | undefined
  return r ? toItem(r) : null
}

/**
 * Drop every waiting message in this chat's conversations: `/cancel` stops
 * everything in the chat, the waiting web messages included. Returns how many.
 */
export function dropQueuedForChat(chatId: string): number {
  return db().prepare("DELETE FROM web_queue WHERE chat_id = ? AND state = 'queued'").run(chatId).changes
}

/** Waiting messages, oldest first. */
export function listQueued(conversationId: string): QueueItem[] {
  return (db().prepare("SELECT * FROM web_queue WHERE conversation_id = ? AND state = 'queued' ORDER BY id").all(conversationId) as RawItem[]).map(toItem)
}

/** Every row of a conversation, oldest first. For tests. */
export function listAllForTest(conversationId: string): QueueItem[] {
  return (db().prepare('SELECT * FROM web_queue WHERE conversation_id = ? ORDER BY id').all(conversationId) as RawItem[]).map(toItem)
}

export function hasQueued(conversationId: string): boolean {
  return !!db().prepare("SELECT 1 FROM web_queue WHERE conversation_id = ? AND state = 'queued' LIMIT 1").get(conversationId)
}

const BLANK = "text = '', attachments = '[]', pastes = '[]'"

/**
 * Take the oldest waiting message. The UPDATE is the claim: an edit or remove
 * racing it loses. It also blanks the row; the message is returned to the
 * caller, who runs it.
 */
export function claimNext(conversationId: string): QueueItem | null {
  const d = db()
  for (;;) {
    const r = d.prepare("SELECT * FROM web_queue WHERE conversation_id = ? AND state = 'queued' ORDER BY id LIMIT 1").get(conversationId) as RawItem | undefined
    if (!r) return null
    if (d.prepare(`UPDATE web_queue SET state = 'running', ${BLANK} WHERE id = ? AND state = 'queued'`).run(r.id).changes === 1) {
      return { ...toItem(r), state: 'running' }
    }
  }
}

export function finishItem(id: number): void {
  db().prepare(`UPDATE web_queue SET state = 'done', ${BLANK} WHERE id = ?`).run(id)
}

/**
 * A 'running' row with no turn behind it was cut off by a restart. It is
 * finished as it stands; the messages queued behind it still run.
 */
export function settleStale(conversationId: string, isRunning: boolean): void {
  if (isRunning) return
  db().prepare(`UPDATE web_queue SET state = 'done', ${BLANK} WHERE conversation_id = ? AND state = 'running'`).run(conversationId)
}

export type ChangeResult = 'ok' | 'missing' | 'started'

function change(conversationId: string, id: number, sql: string, ...vals: unknown[]): ChangeResult {
  if (db().prepare(sql).run(...vals, id, conversationId).changes === 1) return 'ok'
  return getItem(conversationId, id) ? 'started' : 'missing'
}

/** Change a waiting message's text. Refused once its turn has started. */
export function editQueued(conversationId: string, id: number, text: string): ChangeResult {
  return change(conversationId, id, "UPDATE web_queue SET text = ? WHERE id = ? AND conversation_id = ? AND state = 'queued'", text)
}

/** Take a waiting message off the queue. Refused once its turn has started. */
export function removeQueued(conversationId: string, id: number): ChangeResult {
  return change(conversationId, id, "DELETE FROM web_queue WHERE id = ? AND conversation_id = ? AND state = 'queued'")
}

export function deleteQueueForConversation(conversationId: string): void {
  db().prepare('DELETE FROM web_queue WHERE conversation_id = ?').run(conversationId)
}

const PHOTO_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** What the page shows for a message: its text and the names of what it carries. */
export const itemJson = (q: QueueItem) => ({
  id: q.id,
  clientId: q.clientId,
  text: q.text,
  files: [
    ...q.attachments.map((p) => ({ name: basename(p), kind: PHOTO_EXT.has(extname(p).toLowerCase()) ? 'photo' : 'document' })),
    ...q.pastes.map(() => ({ name: 'pasted-text.txt', kind: 'document', pasted: true })),
  ],
  state: q.state,
  createdAt: q.createdAt,
})

// ---------- following a conversation's turns ----------

export type HubListener = (name: string, data: unknown) => void

/** Sent to listeners, never to a page: the current turn has ended. */
export const TURN_END = '__end'
/** Sent to listeners: nothing is running and nothing will start. */
export const IDLE = '__idle'

interface Hub {
  events: Array<{ name: string; data: unknown }>
  listeners: Set<HubListener>
}
const hubs = new Map<string, Hub>()

function hub(conversationId: string): Hub {
  let h = hubs.get(conversationId)
  if (!h) {
    h = { events: [], listeners: new Set() }
    hubs.set(conversationId, h)
  }
  return h
}

function emit(h: Hub, name: string, data: unknown): void {
  for (const l of [...h.listeners]) {
    try {
      l(name, data)
    } catch {
      // one listener must not break the others
    }
  }
}

/**
 * A turn starts: forget the last one's events and announce this one. The
 * announcement names the message but never carries its words: the `user`
 * event shows them once the turn stores them, and a command that holds a key
 * never does.
 */
export function hubBegin(conversationId: string, item: QueueItem): void {
  const h = hub(conversationId)
  h.events = []
  hubWrite(conversationId, 'start', { item: { id: item.id, clientId: item.clientId, state: 'running' } })
}

/**
 * One event of the current turn, kept for a page that joins late. Streamed
 * text is kept as one running piece, so a late page gets the reply so far in
 * a single event.
 */
export function hubWrite(conversationId: string, name: string, data: unknown): void {
  const h = hub(conversationId)
  const last = h.events.at(-1)
  if (name === 'delta' && last && (last.name === 'delta' || last.name === 'reset')) {
    const prev = last.data as { text: string }
    last.data = { text: prev.text + (data as { text: string }).text }
  } else if (name === 'reset') {
    h.events = h.events.filter((e) => e.name !== 'delta' && e.name !== 'reset')
    h.events.push({ name, data })
  } else {
    h.events.push({ name, data })
  }
  emit(h, name, data)
}

export function hubEnd(conversationId: string): void {
  const h = hub(conversationId)
  h.events = []
  emit(h, TURN_END, null)
}

export function hubIdle(conversationId: string): void {
  const h = hubs.get(conversationId)
  if (!h) return
  emit(h, IDLE, null)
  if (!h.listeners.size) hubs.delete(conversationId)
}

/** Listen to a conversation's turns. With replay, the current turn's events so far come first. */
export function hubSubscribe(conversationId: string, listener: HubListener, replay = true): () => void {
  const h = hub(conversationId)
  if (replay) for (const e of h.events) listener(e.name, e.data)
  h.listeners.add(listener)
  return () => {
    h.listeners.delete(listener)
  }
}
