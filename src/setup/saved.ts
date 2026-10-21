/**
 * The non-secret half of a finished setup, kept so the first chat can finish
 * the owner profile later. Never holds a key, token or chat id.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Answers } from './plan.js'

export type SavedSetup = Omit<Answers, 'keys'> & { profilePending: boolean; version: 1 }

export const SETUP_ANSWERS_PATH = 'store/setup-answers.json'

/** Stand-ins written into the profile files until the first chat replaces them. */
export const PROVISIONAL = {
  ownerName: 'the owner',
  assistantName: 'Atlas',
  vibeIndex: 1,
  latitude: '40.71',
  longitude: '-74.01',
  tempUnit: 'celsius',
} as const

/** Drops `keys` entirely, so a secret cannot reach the file. */
export function saveSetupAnswers(projectRoot: string, answers: Answers, profilePending: boolean): void {
  const { keys: _keys, ...rest } = answers
  const saved: SavedSetup = { ...rest, profilePending, version: 1 }
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

export function answersFromSaved(saved: SavedSetup, projectPath: string): Answers {
  const { profilePending: _pending, version: _version, ...rest } = saved
  return { ...rest, keys: {}, projectPath }
}
