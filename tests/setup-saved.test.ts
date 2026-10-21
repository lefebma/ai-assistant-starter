import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  SETUP_ANSWERS_PATH,
  answersFromSaved,
  isProfilePending,
  loadSetupAnswers,
  saveSetupAnswers,
} from '../src/setup/saved.js'
import { writeConfiguration } from '../src/setup/finalize.js'
import type { Answers } from '../src/setup/plan.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'setup-saved-'))
}

function answers(overrides: Partial<Answers> = {}): Answers {
  return {
    ownerName: 'Sam',
    assistantName: 'Atlas',
    timezone: 'America/Toronto',
    city: 'Toronto',
    platform: 'Telegram',
    engine: 'subscription',
    personalityVibe: 'direct',
    ownerBio: 'consultant',
    emailProvider: 'Skip',
    emailAddress: '',
    gmailAddress: '',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: '',
    latitude: '43.65',
    longitude: '-79.38',
    tempUnit: 'celsius',
    monthlyAudit: false,
    skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    keys: {},
    projectPath: '/tmp/x',
    ...overrides,
  }
}

describe('saved setup answers', () => {
  it('saveSetupAnswers strips keys', () => {
    const root = tmp()
    saveSetupAnswers(root, answers({ keys: { anthropic: 'sk-x', perplexity: 'p' } }), true)
    const text = readFileSync(join(root, SETUP_ANSWERS_PATH), 'utf-8')
    expect(text).not.toContain('sk-x')
    expect('keys' in JSON.parse(text)).toBe(false)
  })

  it('round trips', () => {
    const root = tmp()
    saveSetupAnswers(root, answers(), true)
    const saved = loadSetupAnswers(root)
    expect(saved?.profilePending).toBe(true)
    expect(saved?.version).toBe(1)
    expect(saved?.ownerName).toBe('Sam')
    expect(isProfilePending(root)).toBe(true)
  })

  it('answersFromSaved restores empty keys and overrides projectPath', () => {
    const root = tmp()
    saveSetupAnswers(root, answers(), true)
    const back = answersFromSaved(loadSetupAnswers(root)!, '/elsewhere')
    expect(back.keys).toEqual({})
    expect(back.projectPath).toBe('/elsewhere')
    expect('profilePending' in back).toBe(false)
  })

  it('isProfilePending is false without a file', () => {
    expect(isProfilePending(tmp())).toBe(false)
  })

  it('isProfilePending is false for corrupt JSON', () => {
    const root = tmp()
    mkdirSync(join(root, 'store'))
    writeFileSync(join(root, SETUP_ANSWERS_PATH), '{not json')
    expect(loadSetupAnswers(root)).toBeNull()
    expect(isProfilePending(root)).toBe(false)
  })

  it('isProfilePending is false when profilePending is false', () => {
    const root = tmp()
    saveSetupAnswers(root, answers(), false)
    expect(isProfilePending(root)).toBe(false)
  })
})

describe('writeConfiguration answers file', () => {
  function project(): { root: string; home: string } {
    const root = tmp()
    const repo = resolve(__dirname, '..')
    for (const dir of ['templates', 'skills']) {
      if (existsSync(join(repo, dir))) cpSync(join(repo, dir), join(root, dir), { recursive: true })
    }
    return { root, home: tmp() }
  }

  it('writes no answers file without opts', () => {
    const { root, home } = project()
    writeConfiguration(answers(), {}, root, home)
    expect(existsSync(join(root, SETUP_ANSWERS_PATH))).toBe(false)
  })

  it('writes it with { profilePending: true }', () => {
    const { root, home } = project()
    writeConfiguration(answers(), {}, root, home, { profilePending: true })
    expect(isProfilePending(root)).toBe(true)
  })
})
