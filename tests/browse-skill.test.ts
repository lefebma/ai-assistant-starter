/**
 * tests/browse-skill.test.ts
 *
 * The browser tools were registered in .mcp.json for every install, and the
 * libraries have shipped in provisioning since v1.28.1, but nothing told the
 * assistant how to use them. So it launched a browser to read static HTML,
 * screenshotted pages it could have read as text, and left the browser
 * holding 190 MB on a 2 GB box. The skill is that missing half.
 *
 * What is worth a test here is reach and restraint. Reach: an existing box has
 * no way to get a new skill except the always-on sync, and the sync fills only
 * two placeholders. Restraint: a page is data, not instruction, and the
 * triggers must not steal work from web-research.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSkillPlan, installedSkillsList, type Answers } from '../src/setup/plan.js'
import { ALWAYS_ON_SKILLS } from '../src/skills/sync.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(REPO, 'templates', 'skills', 'browse')
const read = (file: string): string => readFileSync(join(SKILL_DIR, file), 'utf-8')

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
  skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
  keys: {},
  projectPath: '/repo',
}

describe('browse skill template', () => {
  it('has a manifest the loader will accept', () => {
    const manifest = JSON.parse(read('manifest.json'))
    expect(manifest.id).toBe('browse')
    expect(manifest.name).toBeTruthy()
    expect(manifest.triggers.length).toBeGreaterThan(0)
    expect(manifest.enabled).toBe(true)
  })

  it('uses only the placeholders an update-path install can substitute', () => {
    // syncAlwaysOnSkills() fills OWNER_NAME and PROJECT_PATH and nothing else.
    const text = ['SKILL.md', 'manifest.json'].map(read).join('\n')
    const used = new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
    expect([...used].sort()).toEqual(['OWNER_NAME', 'PROJECT_PATH'])
  })

  it('names the MCP tools that actually exist', () => {
    // The tool names come from @playwright/mcp. A skill that tells the model to
    // call browser_get_text sends it hunting for a tool nobody serves.
    const skill = read('SKILL.md')
    for (const tool of [
      'browser_navigate',
      'browser_snapshot',
      'browser_take_screenshot',
      'browser_click',
      'browser_close',
    ]) {
      expect(skill).toContain(tool)
    }
  })

  it('treats page content as data rather than instruction', () => {
    // The whole point of reading the live web with an agent, and the one
    // failure that turns a reading tool into an acting one.
    const both = ['SKILL.md', 'manifest.json'].map(read).join('\n')
    expect(both.toLowerCase()).toContain('untrusted')
    expect(read('SKILL.md')).toMatch(/not an instruction|never as direction/i)
  })

  it('says to close the browser when the task ends', () => {
    // 190 MB held open is a tenth of a hosted box.
    expect(read('SKILL.md')).toMatch(/close the browser/i)
  })

  it('tries the cheap path before launching a browser', () => {
    expect(read('SKILL.md')).toContain('curl')
  })

  it('does not steal web-research triggers', () => {
    // Both skills answer questions about the outside world. web-research owns
    // "research X" and "look into X"; browse owns a specific page. Overlapping
    // triggers would route a research question into a browser launch.
    const mine: string[] = JSON.parse(read('manifest.json')).triggers
    const theirs: string[] = JSON.parse(
      readFileSync(join(REPO, 'templates', 'skills', 'web-research', 'manifest.json'), 'utf-8')
    ).triggers
    const collisions = mine.filter((t) => theirs.some((o) => t.includes(o) || o.includes(t)))
    expect(collisions).toEqual([])
  })
})

describe('browse reaches every install', () => {
  it('is always-on, so an existing box picks it up on update', () => {
    expect(ALWAYS_ON_SKILLS).toContain('browse')
  })

  it('is installed by a fresh setup, with its placeholders filled', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    expect(plan).toContainEqual({ type: 'copy', from: 'templates/skills/browse', to: 'skills/browse' })
    const edits = plan.filter((a) => a.type === 'edit' && a.file.startsWith('skills/browse/'))
    expect(edits).toContainEqual({
      type: 'edit',
      file: 'skills/browse/SKILL.md',
      vars: { OWNER_NAME: 'Sam', PROJECT_PATH: '/repo' },
    })
  })

  it('needs no key, so it is never gated behind a secret', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    const secrets = plan.filter((a) => a.type === 'secret')
    expect(secrets.some((s) => JSON.stringify(s).includes('browse'))).toBe(false)
  })

  it('is named in the skills list the assistant is told it has', () => {
    expect(installedSkillsList(BASE)).toContain('browse')
  })
})

describe('the measured tab budget is documented where operators look', () => {
  it('hosted-VPS doc carries the per-tab cost', () => {
    const doc = readFileSync(join(REPO, 'docs', 'HOSTED-VPS.md'), 'utf-8')
    expect(doc).toContain('How many tabs')
    expect(doc).toMatch(/first tab costs about 75 MB/)
  })
})
