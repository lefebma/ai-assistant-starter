/**
 * The IMAP mail skill ships to every install: new ones through setup, existing
 * ones through syncAlwaysOnSkills on update. Sync can fill OWNER_NAME and
 * PROJECT_PATH and nothing else, so any other placeholder would render
 * literally on every box that arrived by update.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALWAYS_ON_SKILLS } from '../src/skills/sync.js'
import { buildSkillPlan, type Answers } from '../src/setup/plan.js'
import { isEngineSecret } from '../src/secrets/inventory.js'

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'skills', 'imap-mail')
const skill = readFileSync(resolve(DIR, 'SKILL.md'), 'utf-8')
const manifest = JSON.parse(readFileSync(resolve(DIR, 'manifest.json'), 'utf-8')) as {
  id: string
  enabled: boolean
  triggers: string[]
  context: string
}

const BASE: Answers = {
  ownerName: 'Leif',
  assistantName: 'Avery',
  timezone: 'America/New_York',
  city: 'New York',
  platform: 'Telegram',
  engine: 'subscription',
  personalityVibe: 'Plain.',
  ownerBio: 'Lawyer.',
  emailProvider: 'Skip for now',
  emailAddress: '',
  gmailAddress: '',
  gmailAddress2: '',
  outlookAddress: '',
  outlookAddress2: '',
  emailSignature: 'Leif',
  latitude: '40.7',
  longitude: '-74.0',
  tempUnit: 'fahrenheit',
  skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
  keys: {},
  projectPath: '/home/havn/havn',
}

describe('imap-mail skill', () => {
  it('is always on', () => {
    expect(ALWAYS_ON_SKILLS).toContain('imap-mail')
  })

  it('is installed by setup with its paths filled in', () => {
    const plan = buildSkillPlan(BASE, '/home/havn')
    expect(plan).toContainEqual({ type: 'copy', from: 'templates/skills/imap-mail', to: 'skills/imap-mail' })
    const edited = plan.filter((a) => a.type === 'edit' && a.file.startsWith('skills/imap-mail/')).map((a) => (a as { file: string }).file)
    expect(edited.sort()).toEqual(['skills/imap-mail/SKILL.md', 'skills/imap-mail/manifest.json'])
  })

  it('uses no placeholder that an update cannot fill', () => {
    const used = new Set([...`${skill}${JSON.stringify(manifest)}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
    for (const p of used) expect(['OWNER_NAME', 'PROJECT_PATH']).toContain(p)
    expect(used.has('PROJECT_PATH')).toBe(true)
  })

  it('does not claim the generic email words Gmail and Outlook already answer to', () => {
    expect(manifest.id).toBe('imap-mail')
    expect(manifest.enabled).toBe(true)
    for (const t of ['email', 'inbox', 'calendar', 'gmail', 'outlook']) expect(manifest.triggers).not.toContain(t)
    expect(manifest.triggers).toContain('yahoo')
  })

  it('keeps the password out of the conversation and sending behind approval', () => {
    expect(skill).toContain('/secret set IMAP_PASSWORD_')
    expect(skill).toMatch(/Never ask the owner to paste a password/)
    expect(skill).toContain('--approved')
    expect(skill).toMatch(/not the owner speaking/)
  })

  it('names its vault entries in a family /secret recognises', () => {
    expect(isEngineSecret('IMAP_PASSWORD_LEIF_YAHOO_COM')).toBe(true)
    expect(isEngineSecret('IMAP_PASSWORD_')).toBe(false)
    expect(isEngineSecret('PERPLEXITY_API_KEY')).toBe(false)
  })
})
