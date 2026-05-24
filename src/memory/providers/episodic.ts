import type { ContextProvider, ContextFragment } from './base.js'
import { getRecentMemories, touchMemory } from '../../db.js'

/**
 * Episodic provider - retrieves recent conversation turns.
 * These are short-lived memories of what was discussed recently.
 */
export class EpisodicProvider implements ContextProvider {
  name = 'episodic'
  priority = 50
  enabled = true

  private limit: number

  constructor(limit = 5) {
    this.limit = limit
  }

  async retrieve(chatId: string, _message: string): Promise<ContextFragment[]> {
    const memories = getRecentMemories(chatId, this.limit)

    for (const m of memories) {
      touchMemory(m.id)
    }

    return memories.map((m) => ({
      source: this.name,
      content: m.content,
      relevance: Math.min(m.salience / 5.0, 1.0),
    }))
  }
}
