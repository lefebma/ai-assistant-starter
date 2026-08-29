/**
 * tests/exec-interview.test.ts
 *
 * The discovery interview is only useful if what it learns survives. Three
 * things have to hold for that: the skill reaches every install (fresh and
 * updated), PROFILE.md is imported by CLAUDE.md so the profile is actually in
 * the system prompt, and no update path overwrites it. Each of those has a
 * cheap way to go wrong silently, so each gets a test.
 */
import { describe, it, expect } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSkillPlan, installedSkillsList, type Answers } from '../src/setup/plan.js'
import { applyPlan } from '../src/setup/execute.js'
import { ALWAYS_ON_SKILLS } from '../src/skills/sync.js'
import { PRESERVED_PATHS } from '../src/update/plan.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(REPO, 'templates', 'skills', 'exec-interview')

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

describe('exec-interview skill template', () => {
  it('has a manifest the loader will accept', () => {
    const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.json'), 'utf-8'))
    expect(manifest.id).toBe('exec-interview')
    expect(manifest.name).toBeTruthy()
    expect(manifest.triggers.length).toBeGreaterThan(0)
    expect(manifest.enabled).toBe(true)
  })

  it('uses only the placeholders an update-path install can substitute', () => {
    // syncAlwaysOnSkills() fills OWNER_NAME and PROJECT_PATH and nothing else.
    // Any other placeholder renders literally for every owner who arrived by
    // update rather than by fresh install, which is most of them.
    const text = ['SKILL.md', 'manifest.json'].map((f) => readFileSync(join(SKILL_DIR, f), 'utf-8')).join('\n')
    const used = new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
    expect([...used].sort()).toEqual(['OWNER_NAME', 'PROJECT_PATH'])
  })

  it('tells the assistant to write PROFILE.md and to wire the import', () => {
    const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
    expect(skill).toContain('PROFILE.md')
    expect(skill).toContain('@PROFILE.md')
  })
})

describe('exec-interview reaches every install', () => {
  it('is always-on, so an existing box picks it up on update', () => {
    expect(ALWAYS_ON_SKILLS).toContain('exec-interview')
  })

  it('is installed by a fresh setup, with its placeholders filled', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    expect(plan).toContainEqual({ type: 'copy', from: 'templates/skills/exec-interview', to: 'skills/exec-interview' })
    const edits = plan.filter((a) => a.type === 'edit' && a.file.startsWith('skills/exec-interview/'))
    expect(edits.map((e) => (e as { file: string }).file).sort()).toEqual([
      'skills/exec-interview/SKILL.md',
      'skills/exec-interview/manifest.json',
    ])
  })

  it('is named in the skills list the assistant is told it has', () => {
    expect(installedSkillsList(BASE)).toContain('exec-interview')
  })
})

describe('the profile survives', () => {
  it('is never overwritten by an update', () => {
    expect(PRESERVED_PATHS).toContain('PROFILE.md')
  })

  it('is scaffolded on a fresh run and imported by CLAUDE.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-interview-'))
    mkdirSync(join(root, 'templates'), { recursive: true })
    for (const f of ['CLAUDE.md.template', 'PERSONALITY.md.template', 'PROFILE.md.template']) {
      cpSync(join(REPO, 'templates', f), join(root, 'templates', f))
    }
    const markdown = buildSkillPlan(BASE, '/home/sam').filter(
      (a) => a.type === 'template' && ['CLAUDE.md', 'PERSONALITY.md', 'PROFILE.md'].includes(a.to)
    )
    applyPlan(markdown, root)

    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toContain('@PROFILE.md')
    const profile = readFileSync(join(root, 'PROFILE.md'), 'utf-8')
    expect(profile).toContain('Sam')
    expect(profile).not.toContain('{{')
  })

  it('leaves a completed profile alone when setup is re-run', () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-interview-'))
    mkdirSync(join(root, 'templates'), { recursive: true })
    for (const f of ['CLAUDE.md.template', 'PERSONALITY.md.template', 'PROFILE.md.template']) {
      cpSync(join(REPO, 'templates', f), join(root, 'templates', f))
    }
    const markdown = () =>
      buildSkillPlan(BASE, '/home/sam').filter(
        (a) => a.type === 'template' && ['CLAUDE.md', 'PERSONALITY.md', 'PROFILE.md'].includes(a.to)
      )
    applyPlan(markdown(), root)
    writeFileSync(join(root, 'PROFILE.md'), '# About Sam\n\nRuns a print shop in Hamilton.\n')
    applyPlan(markdown(), root)

    expect(readFileSync(join(root, 'PROFILE.md'), 'utf-8')).toContain('print shop in Hamilton')
  })
})
