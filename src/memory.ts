import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  insertMemory,
  decayMemories as dbDecay,
  type Memory,
} from './db.js'
import { logger } from './logger.js'

const SEMANTIC_PATTERN = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i

export async function buildMemoryContext(
  chatId: string,
  userMessage: string
): Promise<string> {
  const ftsResults = searchMemories(userMessage, 3)
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

  // Truncate each memory to avoid overwhelming the prompt
  const lines = combined.map((m) => {
    const truncated = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content
    return `- ${truncated} (${m.sector})`
  })
  return `<memory-context hidden="true">\nThe following is background context from previous conversations. DO NOT include this in your response. Use it only to inform your answer.\n${lines.join('\n')}\n</memory-context>`
}

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  // Skip very short messages or commands
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return

  const isSemantic = SEMANTIC_PATTERN.test(userMsg)
  const sector = isSemantic ? 'semantic' : 'episodic'

  // Dedupe: skip if an identical user turn already exists in the last 20 memories.
  // Prevents replay echo loops where an unresolved item gets re-saved every turn.
  const content = `User said: ${userMsg.slice(0, 500)}`
  const recent = getRecentMemories(chatId, 20)
  const alreadyLogged = recent.some((m) => m.content === content)
  if (alreadyLogged) {
    logger.debug({ chatId }, 'Skipping duplicate user turn in memory')
    return
  }
  insertMemory(chatId, content, sector)

  // Save a compressed version of the assistant response for episodic recall
  if (assistantMsg.length > 50) {
    const summary = assistantMsg.slice(0, 300)
    insertMemory(chatId, `Assistant responded: ${summary}`, 'episodic')
  }

  logger.debug({ chatId, sector }, 'Conversation turn saved to memory')
}

export function runDecaySweep(): void {
  logger.info('Running memory decay sweep')
  dbDecay()
}
