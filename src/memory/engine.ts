import type { ContextProvider, ContextFragment } from './providers/base.js'
import { EpisodicProvider } from './providers/episodic.js'
import { SemanticProvider } from './providers/semantic.js'
import { ProjectProvider } from './providers/project.js'
import { CalendarProvider } from './providers/calendar.js'
import { skillsProvider } from './providers/skills.js'
import { AutoMemoryProvider } from './providers/automemory.js'
import { loadSkills } from '../skills/index.js'
import { logger } from '../logger.js'

/**
 * ContextEngine - orchestrates multiple context providers to build
 * rich, relevant context for each conversation turn.
 *
 * Inspired by OpenClaw's ContextEngine plugin architecture,
 * but adapted for our SQLite-backed persistent memory system.
 */
export class ContextEngine {
  private providers: ContextProvider[] = []
  private tokenBudget: number
  private lastFragmentCount = 0  // stale-cache detection

  constructor(tokenBudget = 2000) {
    this.tokenBudget = tokenBudget
  }

  /**
   * Invalidate any provider-level caches. Call on /newchat, memory pruning,
   * or when the source history shrinks (e.g., after compaction).
   * Inspired by OpenClaw v2026.5.7 stale-cache fix.
   */
  invalidateCaches(): void {
    this.lastFragmentCount = 0
    for (const provider of this.providers) {
      if ('invalidateCache' in provider && typeof (provider as any).invalidateCache === 'function') {
        (provider as any).invalidateCache()
      }
    }
    logger.info('Context caches invalidated')
  }

  /** Register a context provider */
  register(provider: ContextProvider): void {
    this.providers.push(provider)
    // Keep sorted by priority descending
    this.providers.sort((a, b) => b.priority - a.priority)
    logger.debug({ provider: provider.name, priority: provider.priority }, 'Registered context provider')
  }

  /** Enable or disable a provider by name */
  setEnabled(name: string, enabled: boolean): boolean {
    const provider = this.providers.find((p) => p.name === name)
    if (!provider) return false
    provider.enabled = enabled
    return true
  }

  /** List all registered providers and their status */
  listProviders(): Array<{ name: string; priority: number; enabled: boolean }> {
    return this.providers.map((p) => ({
      name: p.name,
      priority: p.priority,
      enabled: p.enabled,
    }))
  }

  /** Build context by querying all enabled providers in parallel */
  async buildContext(chatId: string, message: string): Promise<string> {
    const enabled = this.providers.filter((p) => p.enabled)

    if (enabled.length === 0) return ''

    // Query all providers in parallel
    const results = await Promise.allSettled(
      enabled.map(async (provider) => {
        try {
          const fragments = await provider.retrieve(chatId, message)
          return { provider: provider.name, priority: provider.priority, fragments }
        } catch (err) {
          logger.warn({ provider: provider.name, err }, 'Context provider failed')
          return { provider: provider.name, priority: provider.priority, fragments: [] }
        }
      })
    )

    // Collect and score all fragments
    const scored: Array<ContextFragment & { score: number }> = []

    for (const result of results) {
      if (result.status === 'rejected') continue
      const { priority, fragments } = result.value
      for (const fragment of fragments) {
        scored.push({
          ...fragment,
          score: (priority / 100) * fragment.relevance,
        })
      }
    }

    if (scored.length === 0) return ''

    // Stale-cache detection: if fragment count shrank significantly
    // (e.g., after /newchat or memory pruning), invalidate caches.
    if (this.lastFragmentCount > 0 && scored.length < this.lastFragmentCount * 0.5) {
      logger.info(
        { previous: this.lastFragmentCount, current: scored.length },
        'Fragment count shrank, invalidating provider caches'
      )
      this.invalidateCaches()
    }
    this.lastFragmentCount = scored.length

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)

    // Apply token budget (rough estimate: 1 token per 4 chars)
    const charBudget = this.tokenBudget * 4
    const selected: typeof scored = []
    let totalChars = 0

    for (const fragment of scored) {
      if (totalChars + fragment.content.length > charBudget) {
        // Try to fit a truncated version
        const remaining = charBudget - totalChars
        if (remaining > 100) {
          selected.push({
            ...fragment,
            content: fragment.content.slice(0, remaining - 3) + '...',
          })
        }
        break
      }
      selected.push(fragment)
      totalChars += fragment.content.length
    }

    // Deduplicate by content similarity (exact match after trimming)
    const deduped = deduplicateFragments(selected)

    // Format into memory-context block
    const lines = deduped.map((f) => `- ${f.content} (${f.source})`)

    logger.debug(
      {
        providers: enabled.map((p) => p.name),
        fragmentCount: scored.length,
        selectedCount: deduped.length,
        totalChars,
      },
      'Context built'
    )

    return `<memory-context hidden="true">\nPRIOR CONVERSATION HISTORY (already handled in past sessions). These are NOT new requests. DO NOT re-action items listed here, DO NOT repeat answers you already gave, and DO NOT surface unresolved items unless the user explicitly asks about them now. Use this only as background to understand continuity.\n${lines.join('\n')}\n</memory-context>`
  }
}

/** Remove fragments with identical content */
function deduplicateFragments<T extends ContextFragment>(
  fragments: T[]
): T[] {
  const seen = new Set<string>()
  return fragments.filter((f) => {
    const key = f.content.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Create the default ContextEngine with all built-in providers.
 */
export function createDefaultEngine(): ContextEngine {
  const engine = new ContextEngine()

  // Load skills from disk
  const skills = loadSkills()
  logger.info({ count: skills.length }, 'Skills loaded')

  engine.register(new AutoMemoryProvider())  // priority 90
  engine.register(skillsProvider)            // priority 80
  engine.register(new CalendarProvider())    // priority 70
  engine.register(new SemanticProvider())    // priority 60
  engine.register(new EpisodicProvider())    // priority 50
  engine.register(new ProjectProvider())     // priority 40

  return engine
}
