import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  insertMemory,
  decayMemories as dbDecay,
  getDb,
  retireTopic,
  tagMemories,
  type Memory,
} from './db.js'
import { logger } from './logger.js'
import { scopeGone } from './projects/store.js'
import { hasQuoted, ownerWords, recallLine, replyOrigin } from './memory/provenance.js'
import { backedByOwner, extractRememberMarkers, factContent, type RememberMarker } from './memory/remember.js'

const SEMANTIC_PATTERN = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i

export async function buildMemoryContext(
  chatId: string,
  userMessage: string
): Promise<string> {
  const ftsResults = searchMemories(userMessage, 3, chatId)
  const recentResults = getRecentMemories(chatId, 5)

  // Deduplicate by id
  const seen = new Set<number>()
  const combined: Memory[] = []
  for (const m of [...ftsResults, ...recentResults]) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      combined.push(m)
    }
  }

  if (combined.length === 0) return ''

  // Touch each accessed memory (reinforce salience)
  for (const m of combined) {
    touchMemory(m.id)
  }

  // Truncate each memory to avoid overwhelming the prompt. Untrusted ones
  // arrive wrapped; no stored text can close the block (card #235).
  const lines = combined.map((m) => {
    const truncated = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content
    return `- ${recallLine({ origin: m.origin, content: truncated })} (${m.sector})`
  })
  return `<memory-context hidden="true">\nThe following is background context from previous conversations. DO NOT include this in your response. Use it only to inform your answer.\n${lines.join('\n')}\n</memory-context>`
}

/** The lines media.ts puts in a message for each attachment: "[Photo attached: ...]", "[Document attached: ...]". */
const ATTACHMENT_LINE = /\[[A-Za-z][\w ]* attached: /

const UNTRUSTED_BLOCK = /<(untrusted-[\w-]+)>\n?([\s\S]*?)\n?<\/\1>/g

/**
 * Save one turn. Provenance (card #235): the owner's words are saved as
 * owner, with quoted or forwarded text left out of them and saved apart as
 * untrusted. The reply is untrusted when the turn's tools read mail, the web
 * or another source (`reads` from runAgent), since it may repeat what it read.
 *
 * Topics (card #276): each [[remember: topic | fact]] marker (`remembers`,
 * or any left in the reply) is saved as a fact and tags every row this turn
 * saved. In a turn that read nothing from outside, a fact the owner's own words
 * back is the owner's and retires this chat's older rows on the topic; one they
 * do not back is the assistant's and retires nothing. In any other turn it is
 * untrusted, tags only the untrusted rows, and retires nothing.
 */
export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  opts: { reads?: string[]; remembers?: RememberMarker[] } = {}
): Promise<void> {
  // A project deleted while this turn ran stays deleted (card #281).
  if (scopeGone(chatId)) return

  // A marker never reaches storage as text, whoever forgot to strip it.
  const leftover = extractRememberMarkers(assistantMsg)
  const reply = leftover.cleanText
  const remembers = [...(opts.remembers ?? []), ...leftover.remembers]

  // Skip very short messages or commands, unless the reply tagged a fact:
  // "use billing@ now" is short and still worth keeping.
  const skipTurn = userMsg.length <= 20 || userMsg.startsWith('/')
  if (skipTurn && !remembers.length) return

  const quoted = hasQuoted(userMsg)
  const replyFrom = replyOrigin(opts.reads, quoted)
  // An attachment (a photo, document or long paste) is read without a tool,
  // so it leaves no read behind; a marker it led to is not the owner's either.
  const attached = ATTACHMENT_LINE.test(userMsg)
  const trusted = replyFrom === 'assistant' && !attached

  const own = ownerWords(userMsg)
  const isSemantic = SEMANTIC_PATTERN.test(own)
  const sector = isSemantic ? 'semantic' : 'episodic'

  // Dedupe: skip if an identical user turn already exists in the last 20 memories.
  // Prevents replay echo loops where an unresolved item gets re-saved every turn.
  const content = `User said: ${own.slice(0, 500)}`
  const recent = getRecentMemories(chatId, 20)
  const alreadyLogged = !skipTurn && recent.some((m) => m.content === content)
  if (alreadyLogged && !remembers.length) {
    logger.debug({ chatId }, 'Skipping duplicate user turn in memory')
    return
  }

  getDb().transaction(() => {
    const ownerRows: number[] = []
    const untrustedRows: number[] = []
    if (!skipTurn && !alreadyLogged) {
      ownerRows.push(insertMemory(chatId, content, sector, undefined, 'owner'))

      // Quoted or forwarded text: kept, but as what it is.
      for (const m of userMsg.matchAll(UNTRUSTED_BLOCK)) {
        const q = m[2]!.trim()
        if (q.length > 20) untrustedRows.push(insertMemory(chatId, `Quoted or forwarded text: ${q.slice(0, 500)}`, 'episodic', undefined, 'untrusted'))
      }

      // Save a compressed version of the assistant response for episodic recall
      if (reply.length > 50) {
        const id = insertMemory(chatId, `Assistant responded: ${reply.slice(0, 300)}`, 'episodic', undefined, replyFrom)
        if (replyFrom === 'untrusted') untrustedRows.push(id)
        else if (trusted) ownerRows.push(id)
      }
    }

    let retired = 0
    for (const r of remembers) {
      // The marker is the model's text: it is the owner's fact only when the
      // owner's own words in this turn back it (see remember.ts).
      const owners = trusted && backedByOwner(r.text, own)
      const fact = insertMemory(chatId, factContent(r), 'semantic', undefined, owners ? 'owner' : trusted ? 'assistant' : 'untrusted')
      if (!r.topic) continue
      if (owners) {
        tagMemories(chatId, [...ownerRows, fact], r.topic)
        retired += retireTopic(chatId, r.topic, [...ownerRows, ...untrustedRows, fact]).length
      } else if (trusted) {
        // Unbacked: tagged, so a later owner fact on the topic retires it, but it retires nothing.
        tagMemories(chatId, [fact], r.topic)
      } else {
        // An untrusted turn tags only what came from outside: the owner's request
        // to read an email is not the owner speaking on the email's topic.
        tagMemories(chatId, [...untrustedRows, fact], r.topic)
      }
    }
    if (retired) logger.info({ chatId, retired, topics: remembers.filter((r) => r.topic).length }, 'Retired memories replaced by a newer fact')
  })()

  logger.debug({ chatId, sector, facts: remembers.length }, 'Conversation turn saved to memory')
}

export function runDecaySweep(): void {
  logger.info('Running memory decay sweep')
  dbDecay()
}
