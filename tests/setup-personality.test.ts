/**
 * The personality contract, end to end against the real templates: setup
 * writes PERSONALITY.md when it is missing, preserves it when it exists, and
 * CLAUDE.md always ends up reaching it through the @PERSONALITY.md import.
 * This is the fix for setup re-runs clobbering an owner's personality edits —
 * CLAUDE.md is regenerated every run, so nothing an owner wants to keep may
 * live in it.
 */
import { describe, it, expect } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSkillPlan, type Answers } from '../src/setup/plan.js'
import { applyPlan } from '../src/setup/execute.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const BASE: Answers = {
  ownerName: 'Sam',
  assistantName: 'Atlas',
  timezone: 'America/Toronto',
  city: 'Toronto',
  platform: 'Telegram',
  engine: 'subscription',
  personalityVibe: 'Dry wit, zero filler.',
  ownerBio: 'Consultant.',
  emailProvider: 'Skip for now',
  emailAddress: '',
  gmailAddress: '',
  gmailAddress2: '',
  outlookAddress: '',
  outlookAddress2: '',
  emailSignature: 'Sam',
  latitude: '43.65',
  longitude: '-79.38',
  tempUnit: 'celsius',
  skills: { webResearch: false, apollo: false, wordsmith: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
  keys: {},
  projectPath: '/repo',
}

/** Temp project root carrying the repo's real markdown templates. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'setup-personality-'))
  mkdirSync(join(root, 'templates'), { recursive: true })
  for (const f of ['CLAUDE.md.template', 'PERSONALITY.md.template']) {
    cpSync(join(REPO, 'templates', f), join(root, 'templates', f))
  }
  return root
}

/** The two markdown outputs of the full plan, applied like scripts/setup.ts does. */
function runSetup(root: string, answers: Answers) {
  const markdown = buildSkillPlan(answers, '/home/sam').filter(
    (a) => a.type === 'template' && (a.to === 'CLAUDE.md' || a.to === 'PERSONALITY.md')
  )
  return applyPlan(markdown, root)
}

describe('setup personality file', () => {
  it('writes PERSONALITY.md on a fresh run, and CLAUDE.md imports it', () => {
    const root = fixtureRoot()
    runSetup(root, BASE)

    const personality = readFileSync(join(root, 'PERSONALITY.md'), 'utf-8')
    expect(personality).toContain('Your name is Atlas')
    expect(personality).toContain('**Vibe:** Dry wit, zero filler.')

    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('@PERSONALITY.md')
    // The personality itself must not also live in CLAUDE.md, or the next
    // regeneration would resurrect the stock voice over the owner's edits.
    expect(claudeMd).not.toContain('Dry wit')
    expect(claudeMd).not.toContain('Vibe:')
  })

  it('preserves an edited PERSONALITY.md on re-run while CLAUDE.md regenerates', () => {
    const root = fixtureRoot()
    runSetup(root, BASE)
    writeFileSync(join(root, 'PERSONALITY.md'), 'I only answer in limericks.\n')

    const rerun = runSetup(root, { ...BASE, assistantName: 'Beacon' })

    expect(readFileSync(join(root, 'PERSONALITY.md'), 'utf-8')).toBe('I only answer in limericks.\n')
    expect(rerun.skipped).toContain('PERSONALITY.md')
    // CLAUDE.md picked up the new answers — regeneration still works.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8')
    expect(claudeMd).toContain('# Beacon')
    expect(claudeMd).toContain('@PERSONALITY.md')
  })

  it('ships no personality placeholders in the CLAUDE.md template', () => {
    const template = readFileSync(join(REPO, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(template).toContain('@PERSONALITY.md')
    expect(template).not.toContain('{{PERSONALITY_VIBE}}')
    expect(template).not.toContain('{{CUSTOM_RULES}}')
  })
})
