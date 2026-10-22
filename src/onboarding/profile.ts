/**
 * Applying the owner profile from the first chat (card #210).
 *
 * A minimal setup writes every profile-bearing file from provisional values
 * and saves the answers it used (src/setup/saved.ts). This is the other half:
 * merge what the owner told the assistant into those saved answers and
 * re-render the same files with the setup plan's own builders, so the result
 * cannot drift from what a full wizard run would have written.
 *
 * Three rules keep it from destroying anything:
 *
 * 1. **Secrets are never touched.** Every secret step is dropped from the plan.
 * 2. **Owner edits win.** PERSONALITY.md, PROFILE.md and decisions/log.md are
 *    replaced only when they are byte-identical to what the saved answers
 *    rendered. Anything else is left alone and named in `kept`.
 * 3. **Skills are re-copied only while the profile is pending.** The box is
 *    fresh then and nobody has edited them. A later run touches only
 *    CLAUDE.md, the weather skill and the owner-file checks above.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setAppState } from '../db.js'
import { applyPlan } from '../setup/execute.js'
import { buildEmailSignature, buildSkillPlan, substituteTemplate, type Answers, type PlanAction } from '../setup/plan.js'
import { answersFromSaved, loadSetupAnswers, saveSetupAnswers, type SavedSetup } from '../setup/saved.js'
import { InputError, lookUpCity, validName } from '../setup/web/answers.js'
import type { Fetch } from '../setup/web/telegram.js'
import { PERSONALITY_PRESETS } from '../setup/wizard.js'
import { PROFILE_STUB_MARKER } from './interview-offer.js'

/** app_state key holding an ISO timestamp: restart once the current reply is delivered. */
export const RESTART_AFTER_REPLY_KEY = 'restart_after_reply'

export interface ProfileInput {
  ownerName?: string
  assistantName?: string
  city?: string
  vibe?: 'professional' | 'friendly' | 'direct' | string
  bio?: string
}

export interface ProfileResult {
  /** Files and skill folders written. */
  changed: string[]
  /** Files left alone because the owner edited them. */
  kept: string[]
  /** The place the city lookup matched, or the saved city when none was asked. */
  place: string | null
  placeNotFound: boolean
  timezone: string
  timezoneChanged: boolean
}

export interface ProfileDeps {
  fetch: Fetch
  /** Defaults to the app_state table; injected in tests. */
  setState?: (k: string, v: string) => void
}

const NO_SAVED_SETUP =
  'This assistant was set up before profile changes were possible here. Edit CLAUDE.md and PERSONALITY.md directly.'

const PRESET_BY_VIBE: Record<string, string> = {
  professional: PERSONALITY_PRESETS[0]!,
  friendly: PERSONALITY_PRESETS[1]!,
  direct: PERSONALITY_PRESETS[2]!,
}

/** Owner files a setup writes once; replaced here only when untouched. */
const OWNER_FILES_PENDING = new Set(['PERSONALITY.md', 'PROFILE.md', 'decisions/log.md'])
const OWNER_FILES_LATER = new Set(['PERSONALITY.md', 'PROFILE.md'])

/** loadSetupAnswers does no shape check, so refuse a file the plan cannot use. */
function usableSetup(projectRoot: string): SavedSetup {
  const saved = loadSetupAnswers(projectRoot)
  if (
    !saved ||
    typeof saved.ownerName !== 'string' ||
    typeof saved.assistantName !== 'string' ||
    typeof saved.timezone !== 'string' ||
    !saved.skills ||
    typeof saved.skills !== 'object'
  ) {
    throw new InputError(NO_SAVED_SETUP)
  }
  return saved
}

function name(v: string | undefined, max: number, what: string): string | undefined {
  if (v === undefined) return undefined
  if (!validName(v, max)) throw new InputError(`That ${what} cannot be used. Use ${max} characters or fewer, with no quotation marks or backslashes.`)
  return v.trim()
}

function vibe(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  const preset = PRESET_BY_VIBE[t.toLowerCase()]
  if (preset) return preset
  if (!t || t.length > 300 || /[\u0000-\u001f\u007f]/.test(t)) {
    throw new InputError('Describe the vibe in a sentence or two, 300 characters or fewer.')
  }
  return t
}

function bio(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  // Newlines are fine in a bio; it only lands in markdown.
  if (t.length > 600 || /[\u0000-\u001f\u007f]/.test(t.replace(/\n/g, ''))) {
    throw new InputError('That bio cannot be used. Keep it to 600 characters or fewer.')
  }
  return t
}

/** Every validation runs before anything is looked up or written. */
function validate(input: ProfileInput) {
  const city = typeof input.city === 'string' && input.city.trim() ? name(input.city, 80, 'city') : undefined
  return {
    ownerName: name(input.ownerName, 80, 'name'),
    assistantName: name(input.assistantName, 40, 'assistant name'),
    city,
    personalityVibe: vibe(input.vibe),
    ownerBio: bio(input.bio),
  }
}

function templateFor(plan: PlanAction[], to: string): Extract<PlanAction, { type: 'template' }> | undefined {
  return plan.find((a): a is Extract<PlanAction, { type: 'template' }> => a.type === 'template' && a.to === to)
}

/**
 * Decide what to do with one write-once owner file: write the new render
 * (the file is missing or exactly what the old answers produced), keep it
 * (the owner edited it), or drop it silently (PROFILE.md the interview wrote).
 */
function ownerFileAction(
  action: Extract<PlanAction, { type: 'template' }>,
  oldPlan: PlanAction[],
  projectRoot: string,
  kept: string[]
): PlanAction | null {
  const path = resolve(projectRoot, action.to)
  if (!existsSync(path)) return action
  const onDisk = readFileSync(path, 'utf-8')
  if (action.to === 'PROFILE.md' && !onDisk.includes(PROFILE_STUB_MARKER)) return null
  const old = templateFor(oldPlan, action.to)
  const oldRender = old ? substituteTemplate(readFileSync(resolve(projectRoot, old.from), 'utf-8'), old.vars) : null
  if (onDisk !== oldRender) {
    kept.push(action.to)
    return null
  }
  return { ...action, onlyIfMissing: false }
}

function selectActions(plan: PlanAction[], oldPlan: PlanAction[], pending: boolean, projectRoot: string, kept: string[]): PlanAction[] {
  const out: PlanAction[] = []
  for (const action of plan) {
    if (action.type === 'secret') continue
    if (action.type === 'template') {
      const ownerFiles = pending ? OWNER_FILES_PENDING : OWNER_FILES_LATER
      if (action.onlyIfMissing) {
        if (!ownerFiles.has(action.to)) continue
        const chosen = ownerFileAction(action, oldPlan, projectRoot, kept)
        if (chosen) out.push(chosen)
      } else if (pending || action.to === 'CLAUDE.md') {
        out.push(action)
      }
      continue
    }
    if (pending) {
      out.push(action)
    } else if (
      (action.type === 'copy' && action.to === 'skills/weather') ||
      (action.type === 'edit' && action.file === 'skills/weather/manifest.json')
    ) {
      out.push(action)
    }
  }
  return out
}

/** Replace the TIMEZONE= line, or append one, leaving every other line as it was. */
function writeEnvTimezone(projectRoot: string, timezone: string): boolean {
  const path = resolve(projectRoot, '.env')
  // No .env means no running assistant to restart, and creating one here
  // would make the web setup think this box is already configured.
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf-8')
  const line = `TIMEZONE=${timezone}`
  const updated = /^TIMEZONE=.*$/m.test(text)
    ? text.replace(/^TIMEZONE=.*$/gm, () => line)
    : text + (text === '' || text.endsWith('\n') ? '' : '\n') + line + '\n'
  writeFileSync(path, updated)
  return true
}

export async function applyProfile(projectRoot: string, home: string, input: ProfileInput, deps: ProfileDeps): Promise<ProfileResult> {
  const saved = usableSetup(projectRoot)
  const fields = validate(input)
  const pending = saved.profilePending === true
  const projectPath = typeof saved.projectPath === 'string' && saved.projectPath ? saved.projectPath : projectRoot
  const old = answersFromSaved(saved, projectPath)

  const merged: Answers = { ...old }
  if (fields.ownerName !== undefined) merged.ownerName = fields.ownerName
  if (fields.assistantName !== undefined) merged.assistantName = fields.assistantName
  if (fields.personalityVibe !== undefined) merged.personalityVibe = fields.personalityVibe
  if (fields.ownerBio !== undefined) merged.ownerBio = fields.ownerBio
  const defaultSignature = (n: string) => buildEmailSignature({ name: n, title: '', phone: '', email: '' })
  if (old.emailSignature === defaultSignature(old.ownerName)) merged.emailSignature = defaultSignature(merged.ownerName)

  let place: string | null = old.city || null
  let placeNotFound = false
  if (fields.city !== undefined) {
    // Kept as typed whatever the lookup says; only coordinates and the
    // timezone wait for a match. lookUpCity never throws.
    merged.city = fields.city
    const found = await lookUpCity(deps.fetch, fields.city)
    if (found) {
      place = found.label
      merged.latitude = found.latitude
      merged.longitude = found.longitude
      merged.tempUnit = found.tempUnit
      if (found.timezone) merged.timezone = found.timezone
    } else {
      place = null
      placeNotFound = true
      // The old city's coordinates would answer for the wrong place.
      merged.latitude = ''
      merged.longitude = ''
    }
  }

  const kept: string[] = []
  const actions = selectActions(buildSkillPlan(merged, home), buildSkillPlan(old, home), pending, projectRoot, kept)
  const changed = applyPlan(actions, projectRoot).written

  const timezoneChanged = merged.timezone !== old.timezone && writeEnvTimezone(projectRoot, merged.timezone)
  saveSetupAnswers(projectRoot, merged, false)
  // Only once the answers are saved, so a failed save cannot leave a restart
  // queued for a change that was never recorded.
  if (timezoneChanged) (deps.setState ?? setAppState)(RESTART_AFTER_REPLY_KEY, new Date().toISOString())
  return { changed, kept, place, placeNotFound, timezone: merged.timezone, timezoneChanged }
}

/** The owner declined the welcome questions: clear the flag, change nothing else. */
export function skipProfile(projectRoot: string): void {
  const saved = loadSetupAnswers(projectRoot)
  if (!saved) return
  const projectPath = typeof saved.projectPath === 'string' ? saved.projectPath : projectRoot
  saveSetupAnswers(projectRoot, answersFromSaved(saved, projectPath), false)
}
