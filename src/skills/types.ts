/**
 * Skill manifest schema.
 *
 * A skill is a drop-in integration folder with:
 *   manifest.json  - triggers, context, metadata
 *   SKILL.md       - optional detailed instructions injected into agent context
 */

export interface SkillManifest {
  /** Unique skill ID (e.g. "weather", "apollo", "kanban-zone") */
  id: string

  /** Display name */
  name: string

  /** One-line description */
  description: string

  /** Whether this skill is active */
  enabled: boolean

  /** Keyword triggers (case-insensitive). If any match the message, skill context is injected. */
  triggers: string[]

  /** Static context string injected when triggered (tool commands, credentials paths, etc.) */
  context?: string

  /** Priority for ordering when multiple skills trigger (higher = first). Default 50. */
  priority?: number
}

export interface LoadedSkill {
  manifest: SkillManifest
  /** Content of SKILL.md if present */
  instructions?: string
  /** Directory path */
  dir: string
}
