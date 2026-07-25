import { existsSync, readFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { dashboardFile } from './paths.js'

export type SkillInput = {
  placeholder?: string
  default?: string
  required?: boolean
}

export type Skill = {
  id: string
  label: string
  description: string
  category: string
  prompt: string
  needsConfirm?: boolean
  shareWithTelegram?: boolean
  expectedDurationSec?: number
  input?: SkillInput
}

function isSkill(x: any): x is Skill {
  return (
    x && typeof x === 'object' &&
    typeof x.id === 'string' &&
    typeof x.label === 'string' &&
    typeof x.description === 'string' &&
    typeof x.category === 'string' &&
    typeof x.prompt === 'string'
  )
}

export function loadRegistry(): Skill[] {
  const primary = dashboardFile('skills.json')
  if (!primary) return [] // dashboard integration off — silent, not an error
  const fallback = dashboardFile('skills.example.json')!
  const path = existsSync(primary) ? primary : fallback
  if (!existsSync(path)) {
    logger.warn({ path }, 'cockpit: no skills registry found')
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) {
      logger.error({ path }, 'cockpit: registry must be a JSON array')
      return []
    }
    const valid: Skill[] = []
    for (const entry of raw) {
      if (isSkill(entry)) valid.push(entry)
      else logger.warn({ entry }, 'cockpit: skipping invalid skill entry')
    }
    return valid
  } catch (err) {
    logger.error({ err, path }, 'cockpit: failed to parse registry')
    return []
  }
}

export function findSkill(id: string): Skill | undefined {
  return loadRegistry().find(s => s.id === id)
}

export function publicRegistry(): Omit<Skill, 'prompt'>[] {
  return loadRegistry().map(({ prompt: _omit, ...rest }) => rest)
}
