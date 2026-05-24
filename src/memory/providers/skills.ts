import type { ContextProvider, ContextFragment } from './base.js'
import { matchSkills, buildSkillContext } from '../../skills/index.js'

/**
 * ContextProvider that injects matched skill context into the memory pipeline.
 * Triggers based on keyword matching from skill manifests.
 */
export const skillsProvider: ContextProvider = {
  name: 'skills',
  priority: 80, // High priority - skills are explicit integrations
  enabled: true,

  async retrieve(_chatId: string, message: string): Promise<ContextFragment[]> {
    const matched = matchSkills(message)
    if (matched.length === 0) return []

    const context = buildSkillContext(matched)
    return [{
      source: 'skills',
      content: context,
      relevance: 0.9,
    }]
  },
}
