import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import type { SkillManifest, LoadedSkill } from './types.js'

/** Directories to scan for skills, in order */
const SKILL_DIRS = [
  resolve(homedir(), '.ai-assistant', 'skills'),  // user-level
  resolve(process.cwd(), 'skills'),              // project-level
]

let loadedSkills: LoadedSkill[] = []

/**
 * Scan skill directories and load all valid manifests.
 * Later directories override earlier ones (project > user).
 */
export function loadSkills(): LoadedSkill[] {
  const skillMap = new Map<string, LoadedSkill>()

  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue

    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry)
      if (!statSync(skillDir).isDirectory()) continue

      const manifestPath = join(skillDir, 'manifest.json')
      if (!existsSync(manifestPath)) continue

      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        const manifest = JSON.parse(raw) as SkillManifest

        // Validate required fields
        if (!manifest.id || !manifest.name || !manifest.triggers?.length) {
          logger.warn({ skillDir }, 'Skill manifest missing required fields, skipping')
          continue
        }

        // Default values
        manifest.enabled = manifest.enabled !== false
        manifest.priority = manifest.priority ?? 50

        // Load SKILL.md if present
        const instructionsPath = join(skillDir, 'SKILL.md')
        const instructions = existsSync(instructionsPath)
          ? readFileSync(instructionsPath, 'utf-8')
          : undefined

        skillMap.set(manifest.id, { manifest, instructions, dir: skillDir })
        logger.info({ id: manifest.id, triggers: manifest.triggers.length }, 'Skill loaded')
      } catch (err) {
        logger.warn({ err, skillDir }, 'Failed to load skill manifest')
      }
    }
  }

  loadedSkills = Array.from(skillMap.values())
  return loadedSkills
}

/**
 * Get all loaded skills.
 */
export function getSkills(): LoadedSkill[] {
  return loadedSkills
}

/**
 * Get enabled skills whose triggers match the given message.
 * Returns skills sorted by priority (highest first).
 */
export function matchSkills(message: string): LoadedSkill[] {
  const lower = message.toLowerCase()

  return loadedSkills
    .filter(s => s.manifest.enabled)
    .filter(s => s.manifest.triggers.some(t => lower.includes(t.toLowerCase())))
    .sort((a, b) => (b.manifest.priority ?? 50) - (a.manifest.priority ?? 50))
}

/**
 * Build an always-on catalog of available skills so the assistant knows its full
 * toolbox without every SKILL.md being loaded. Unlike buildSkillContext (which
 * only fires on a keyword match), this lists every enabled skill as a one-liner
 * so the model can discover and route to a skill even when the user's wording
 * doesn't contain a literal trigger. Full instructions still load lazily via the
 * existing trigger path when a trigger word appears.
 *
 * Returns '' when no skills are enabled.
 */
export function buildSkillIndex(): string {
  const enabled = loadedSkills.filter(s => s.manifest.enabled)
  if (enabled.length === 0) return ''

  const lines = enabled
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    .map(s => {
      const triggers = s.manifest.triggers.join(', ')
      return `- ${s.manifest.id}: ${s.manifest.description} (triggers: ${triggers})`
    })

  return [
    '<available-skills>',
    'These are integrations you can use. Mentioning a topic below pulls in that skill\'s full instructions and credentials automatically. If one is relevant to the request, use it even if the user did not name it exactly.',
    ...lines,
    '</available-skills>',
  ].join('\n')
}

/**
 * Build context string from matched skills.
 * Combines manifest.context and SKILL.md instructions.
 */
export function buildSkillContext(skills: LoadedSkill[]): string {
  if (skills.length === 0) return ''

  const parts: string[] = []
  for (const skill of skills) {
    const sections: string[] = [`## Skill: ${skill.manifest.name}`]
    if (skill.manifest.context) sections.push(skill.manifest.context)
    if (skill.instructions) sections.push(skill.instructions)
    parts.push(sections.join('\n'))
  }

  return `<skill-context>\n${parts.join('\n\n---\n\n')}\n</skill-context>`
}

/**
 * Enable or disable a skill by ID. Returns true if found.
 */
export function setSkillEnabled(id: string, enabled: boolean): boolean {
  const skill = loadedSkills.find(s => s.manifest.id === id)
  if (!skill) return false
  skill.manifest.enabled = enabled
  return true
}

/**
 * Reload all skills from disk.
 */
export function reloadSkills(): LoadedSkill[] {
  return loadSkills()
}
