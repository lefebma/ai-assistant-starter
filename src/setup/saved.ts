/**
 * The non-secret half of a finished setup, kept so the first chat can finish
 * the owner profile later. Never holds a key, token or chat id.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Answers } from './plan.js'

/**
 * The key-derived fields that are not secrets: skill templates are rendered
 * from them, so re-rendering a skill without them would blank its config.
 */
export const SKILL_CONFIG_FIELDS = ['wpSiteUrl', 'wpUsername', 'obsidianVaultPath', 'kzBoardId'] as const
export type SkillConfig = Partial<Pick<Answers['keys'], (typeof SKILL_CONFIG_FIELDS)[number]>>

export type SavedSetup = Omit<Answers, 'keys'> & { skillConfig?: SkillConfig; profilePending: boolean; version: 1 }

export const SETUP_ANSWERS_PATH = 'store/setup-answers.json'

/** Stand-ins written into the profile files until the first chat replaces them. */
export const PROVISIONAL = {
  ownerName: 'the owner',
  assistantName: 'Atlas',
  vibeIndex: 1,
  // No coordinates until a city is looked up. A made-up default answered
  // "what's the weather?" with New York's, wherever the owner was (card #126);
  // empty, the weather skill looks the place up or asks for it instead.
  latitude: '',
  longitude: '',
  tempUnit: 'celsius',
} as const

/** Copies only the named non-secret fields, so nothing else in `keys` can follow. */
function pickSkillConfig(from: Record<string, unknown> | undefined): SkillConfig {
  const out: SkillConfig = {}
  for (const field of SKILL_CONFIG_FIELDS) {
    const v = from?.[field]
    if (typeof v === 'string' && v) out[field] = v
  }
  return out
}

/** Drops `keys` except the named skill config, so a secret cannot reach the file. */
export function saveSetupAnswers(projectRoot: string, answers: Answers, profilePending: boolean): void {
  const { keys, ...rest } = answers
  const saved: SavedSetup = { ...rest, skillConfig: pickSkillConfig(keys), profilePending, version: 1 }
  const file = resolve(projectRoot, SETUP_ANSWERS_PATH)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 })
}

/** Null when the file is missing or unparseable. */
export function loadSetupAnswers(projectRoot: string): SavedSetup | null {
  try {
    const parsed = JSON.parse(readFileSync(resolve(projectRoot, SETUP_ANSWERS_PATH), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as SavedSetup) : null
  } catch {
    return null
  }
}

/** True only when the file exists and says so. An install without it is never pending. */
export function isProfilePending(projectRoot: string): boolean {
  return loadSetupAnswers(projectRoot)?.profilePending === true
}

/** The skill config comes back as `keys`; every secret stays absent. */
export function answersFromSaved(saved: SavedSetup, projectPath: string): Answers {
  const { profilePending: _pending, version: _version, skillConfig, ...rest } = saved
  return { ...rest, keys: pickSkillConfig(skillConfig), projectPath }
}
