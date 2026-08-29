import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, resolveTimezone } from '../src/env.js'
import { buildSkillPlan } from '../src/setup/plan.js'
import type { Answers } from '../src/setup/plan.js'

const SKILL_DIR = resolve(PROJECT_ROOT, 'templates', 'skills', 'daily-briefing')
const skillMd = () => readFileSync(resolve(SKILL_DIR, 'SKILL.md'), 'utf-8')
const manifest = () => JSON.parse(readFileSync(resolve(SKILL_DIR, 'manifest.json'), 'utf-8'))

function answers(over: Partial<Answers> = {}): Answers {
  return {
    ownerName: 'Renée',
    assistantName: 'Havn',
    timezone: 'America/Toronto',
    city: 'Toronto',
    platform: 'telegram',
    engine: 'subscription',
    personalityVibe: 'direct',
    ownerBio: 'bio',
    emailProvider: 'gmail',
    emailAddress: 'a@b.com',
    gmailAddress: 'a@b.com',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: '',
    latitude: '43.65',
    longitude: '-79.38',
    tempUnit: 'celsius',
    skills: {
      webResearch: false, apollo: false,
      antilibrary: false, notion: false, kanbanzone: false, wordpress: false,
    },
    keys: {},
    projectPath: '/install',
    ...over,
  } as Answers
}

describe('daily-briefing skill template', () => {
  it('exists with both files the loader needs', () => {
    expect(existsSync(resolve(SKILL_DIR, 'SKILL.md'))).toBe(true)
    expect(existsSync(resolve(SKILL_DIR, 'manifest.json'))).toBe(true)
  })

  it('triggers on the words a scheduled briefing prompt actually contains', () => {
    // The scheduled task fires as a fresh message. If its prompt does not hit a
    // trigger, the skill never loads and the briefing is improvised from
    // nothing — which is how the first one ended up dumping a raw email table.
    const triggers: string[] = manifest().triggers
    const scheduledPrompt = 'Run my daily briefing'.toLowerCase()
    expect(triggers.some((t) => scheduledPrompt.includes(t.toLowerCase()))).toBe(true)
  })

  it('also triggers on scheduling language, so it can teach the CLI', () => {
    const triggers: string[] = manifest().triggers
    for (const phrase of ['schedule this every morning', 'make it recurring']) {
      expect(triggers.some((t) => phrase.includes(t.toLowerCase()))).toBe(true)
    }
  })

  it('forbids pasting raw tool output, the actual complaint', () => {
    const md = skillMd()
    expect(md).toMatch(/never paste raw tool output/i)
    // The columns that made the first briefing unreadable on a phone.
    expect(md).toMatch(/label/i)
    expect(md).toMatch(/thread/i)
  })

  it('covers all four sections that were asked for', () => {
    const md = skillMd().toLowerCase()
    for (const section of ['weather', 'email', 'calendar', 'loose ends']) {
      expect(md).toContain(section)
    }
  })

  it('splits email into needs-a-reply and a summary of the rest', () => {
    const md = skillMd()
    expect(md).toMatch(/needs \{\{OWNER_NAME\}\}/i)
    expect(md).toMatch(/everything else/i)
  })

  it('points at the in-product scheduler and rules out hand-rolled cron', () => {
    const md = skillMd()
    expect(md).toContain('schedule-cli.js create')
    // Every mechanism the agent reached for instead, named so it does not.
    const flat = md.toLowerCase().replace(/\s+/g, ' ')
    for (const wrong of ['cron entry', 'launchd', 'systemd', 'harness']) {
      expect(flat).toContain(wrong)
    }
  })

  it('tells the agent where chat_id comes from, so scheduling cannot half-work', () => {
    expect(skillMd()).toContain('ALLOWED_CHAT_ID')
  })

  it('uses no placeholder that syncAlwaysOnSkills cannot fill', () => {
    // Installs arriving by update are populated by sync.ts, which substitutes
    // OWNER_NAME and PROJECT_PATH only. Anything else renders literally.
    const found = [...skillMd().matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
    expect([...new Set(found)].sort()).toEqual(['OWNER_NAME'])
  })
})

describe('daily-briefing reaches installs both ways', () => {
  it('fresh installs get it from the setup plan', () => {
    const plan = buildSkillPlan(answers(), '/home/x')
    const copied = plan.some(
      (a) => a.type === 'copy' && a.from === 'templates/skills/daily-briefing'
    )
    expect(copied).toBe(true)
  })

  it('it is unconditional, not behind an opt-in flag', () => {
    // Same plan with every optional skill off: it must still be there.
    const plan = buildSkillPlan(answers(), '/home/x')
    expect(plan.some((a) => a.type === 'copy' && a.from === 'templates/skills/daily-briefing')).toBe(true)
  })

  it('existing installs get it from the always-on list', () => {
    const sync = readFileSync(resolve(PROJECT_ROOT, 'src', 'skills', 'sync.ts'), 'utf-8')
    expect(sync).toMatch(/ALWAYS_ON_SKILLS = \[[^\]]*'daily-briefing'/s)
  })
})

describe('shipped system prompt teaches the scheduler CLI', () => {
  const template = () =>
    readFileSync(resolve(PROJECT_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')

  it('gives the agent an invocation it can actually run', () => {
    // It previously documented only the slash command, which the agent cannot
    // send to itself — so it invented its own scheduling instead.
    expect(template()).toContain('schedule-cli.js create')
  })

  it('rules out the mechanisms outside the product', () => {
    // Whitespace-collapsed: this is prose, and rewrapping a paragraph must not
    // break the check that the paragraph still says the thing.
    const t = template().toLowerCase().replace(/\s+/g, ' ')
    for (const wrong of ['launchd', 'systemd', 'cron entry', 'harness']) {
      expect(t).toContain(wrong)
    }
  })

  it('still documents the owner-facing command too', () => {
    expect(template()).toContain('/schedule create')
  })
})

describe('timezone resolution', () => {
  it('prefers process env, then .env, then the host', () => {
    expect(resolveTimezone('Europe/London', 'America/Toronto', 'Asia/Tokyo')).toBe('Europe/London')
    expect(resolveTimezone(undefined, 'America/Toronto', 'Asia/Tokyo')).toBe('America/Toronto')
    expect(resolveTimezone(undefined, undefined, 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('falls back to UTC rather than to the author\'s city', () => {
    expect(resolveTimezone(undefined, undefined, undefined)).toBe('UTC')
    expect(resolveTimezone('', '  ', '')).toBe('UTC')
  })

  it('no shipped code pins America/Toronto any more', () => {
    // The regression: a scheduled 8am briefing fired at 8am Toronto for an
    // owner anywhere else, and the model was told Toronto's clock as fact.
    for (const f of ['src/schedule-cli.ts', 'src/runtime/ai-sdk/prompt.ts']) {
      const code = readFileSync(resolve(PROJECT_ROOT, f), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code).not.toContain('America/Toronto')
    }
  })

  it('createTask no longer defaults new rows to the author\'s city', () => {
    const db = readFileSync(resolve(PROJECT_ROOT, 'src', 'db.ts'), 'utf-8')
    expect(db).toMatch(/timezone = installTimezone\(\)/)
  })
})
