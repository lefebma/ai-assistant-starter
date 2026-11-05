import type { ContextProvider, ContextFragment } from './base.js'
import { searchMemories, touchMemory } from '../../db.js'
import { isUntrusted } from '../provenance.js'

/**
 * Semantic provider - retrieves memories matching the current message
 * via full-text search. These capture facts, preferences, and identity.
 */
export class SemanticProvider implements ContextProvider {
  name = 'semantic'
  priority = 60
  enabled = true

  private limit: number

  constructor(limit = 3) {
    this.limit = limit
  }

  async retrieve(chatId: string, message: string): Promise<ContextFragment[]> {
    const memories = searchMemories(message, this.limit, chatId)

    for (const m of memories) {
      touchMemory(m.id)
    }

    return memories.map((m) => ({
      source: this.name,
      content: m.content,
      ...(isUntrusted(m) ? { untrusted: true as const } : {}),
      relevance: Math.min(m.salience / 5.0, 1.0),
    }))
  }
}
