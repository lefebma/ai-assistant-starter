import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  substituteTemplate,
  buildEmailSignature,
  buildEnvContent,
  buildSkillPlan,
  hostOsLabel,
  shouldSkipSecret,
} from '../src/setup/plan.js'
import { runWizard, type Prompter } from '../src/setup/wizard.js'
import type { Answers } from '../src/setup/plan.js'

const BASE: Answers = {
  ownerName: 'Sam',
  assistantName: 'Atlas',
  timezone: 'America/Toronto',
  city: 'Toronto',
  platform: 'Telegram',
  personalityVibe: 'Direct.',
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

describe('substituteTemplate', () => {
  it('replaces known placeholders and blanks unknown ones', () => {
    expect(substituteTemplate('Hi {{OWNER_NAME}}, {{CUSTOM_RULES}}done', { OWNER_NAME: 'Sam' })).toBe('Hi Sam, done')
  })
})

describe('buildEmailSignature', () => {
  it('joins only the provided parts', () => {
    expect(buildEmailSignature({ name: 'Sam', title: '', phone: '555', email: 's@x.com' })).toBe('Sam\\n555\\ns@x.com')
  })
})

describe('buildEnvContent', () => {
  it('emits telegram credential keys', () => {
    const env = buildEnvContent(BASE)
    expect(env).toContain('TELEGRAM_BOT_TOKEN=')
    expect(env).toContain('ALLOWED_CHAT_ID=')
  })

  it('emits slack keys for slack installs and the wordsmith key when enabled', () => {
    const env = buildEnvContent({
      ...BASE,
      platform: 'Slack',
      skills: { ...BASE.skills, wordsmith: true },
      keys: { google: 'g-123' },
    })
    expect(env).toContain('SLACK_BOT_TOKEN=')
    expect(env).toContain('GOOGLE_API_KEY=g-123')
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN')
  })
})

describe('hostOsLabel', () => {
  it('names each supported platform', () => {
    expect(hostOsLabel('darwin')).toBe('Mac')
    expect(hostOsLabel('win32')).toBe('Windows PC')
    expect(hostOsLabel('linux')).toBe('Linux machine')
  })

  it('falls back to a neutral label rather than guessing Mac', () => {
    expect(hostOsLabel('freebsd')).toBe('computer')
  })
})

describe('buildSkillPlan', () => {
  it('stamps the real host OS into CLAUDE.md, not a hardcoded Mac', () => {
    const claudeMd = (platform: string) =>
      buildSkillPlan(BASE, '/home/sam', platform).find(
        (a) => a.type === 'template' && a.to === 'CLAUDE.md',
      ) as Extract<ReturnType<typeof buildSkillPlan>[number], { type: 'template' }>

    expect(claudeMd('win32').vars.HOST_OS).toBe('Windows PC')
    expect(claudeMd('linux').vars.HOST_OS).toBe('Linux machine')
    expect(claudeMd('darwin').vars.HOST_OS).toBe('Mac')
  })

  it('always installs weather, decision-log, and skill-builder', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    const copies = plan.filter((a) => a.type === 'copy').map((a) => a.to)
    expect(copies).toContain('skills/weather')
    expect(copies).toContain('skills/decision-log')
    expect(copies).toContain('skills/skill-builder')
  })

  it('renames id and name for a secondary gmail account', () => {
    const plan = buildSkillPlan(
      { ...BASE, emailProvider: 'Gmail', gmailAddress: 'a@g.com', gmailAddress2: 'b@g.com', emailAddress: 'a@g.com' },
      '/home/sam'
    )
    const copies = plan.filter((a) => a.type === 'copy').map((a) => a.to)
    expect(copies).toContain('skills/gmail')
    expect(copies).toContain('skills/gmail-secondary')
    const edit = plan.find((a) => a.type === 'edit' && a.file === 'skills/gmail-secondary/manifest.json')!
    expect(edit.literals).toContainEqual({ find: '"id": "gmail"', replace: '"id": "gmail-secondary"' })
    expect(edit.vars?.EMAIL_ADDRESS).toBe('b@g.com')
  })

  it('plans the apollo secret at the path the skill reads', () => {
    const plan = buildSkillPlan(
      { ...BASE, skills: { ...BASE.skills, apollo: true }, keys: { apollo: 'ap-1' } },
      '/home/sam'
    )
    const secret = plan.find((a) => a.type === 'secret')!
    expect(secret.path).toBe('/home/sam/.apollo-api-key')
    expect(secret.value).toBe('ap-1')
  })

  it('substitutes weather coordinates into the manifest', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    const edit = plan.find((a) => a.type === 'edit' && a.file === 'skills/weather/manifest.json')!
    expect(edit.vars).toMatchObject({ LATITUDE: '43.65', LONGITUDE: '-79.38', TEMP_UNIT: 'celsius' })
  })
})

describe('shouldSkipSecret', () => {
  it('skips existing non-empty files, including through symlinks', () => {
    const d = mkdtempSync(join(tmpdir(), 'setup-secret-'))
    const real = join(d, 'real-key')
    writeFileSync(real, 'existing')
    const link = join(d, 'link-key')
    symlinkSync(real, link)
    expect(shouldSkipSecret(join(d, 'missing'))).toBe(false)
    expect(shouldSkipSecret(real)).toBe(true)
    expect(shouldSkipSecret(link)).toBe(true)
  })

  it('does not skip an empty file', () => {
    const d = mkdtempSync(join(tmpdir(), 'setup-secret-'))
    const empty = join(d, 'empty')
    writeFileSync(empty, '')
    expect(shouldSkipSecret(empty)).toBe(false)
  })
})

function scripted(answers: Array<string | boolean | number>): Prompter {
  const queue = [...answers]
  const next = () => {
    if (queue.length === 0) throw new Error('wizard asked more questions than scripted')
    return queue.shift()!
  }
  return {
    ask: async () => String(next()),
    choice: async (_q, options) => {
      const v = next()
      return typeof v === 'number' ? options[v] : String(v)
    },
    yesNo: async () => Boolean(next()),
    say: () => {},
  }
}

describe('runWizard', () => {
  it('assembles answers for a minimal skip-everything run', async () => {
    const p = scripted([
      'Sam', 'Atlas', 'America/Toronto', 'Toronto', // identity
      'Telegram', // platform
      2, // personality preset index 2 (direct, no-nonsense)
      'Consultant.', // bio
      'Skip for now', // email
      'Sam', '', '', '', // signature parts
      '43.65', '-79.38', 'celsius', // weather
      false, false, false, false, false, false, false, // seven skill opt-ins
    ])
    const a = await runWizard(p, '/repo')
    expect(a.ownerName).toBe('Sam')
    expect(a.platform).toBe('Telegram')
    expect(a.personalityVibe).toContain('Direct')
    expect(a.emailProvider).toBe('Skip for now')
    expect(Object.values(a.skills).every((v) => v === false)).toBe(true)
  })

  it('collects secondary gmail and apollo key when opted in', async () => {
    const p = scripted([
      'Sam', 'Atlas', 'America/Toronto', 'Toronto',
      'Telegram',
      1, // preset
      'Bio',
      'Gmail', 'a@g.com', true, 'b@g.com', // gmail + secondary
      'Sam', '', '', 'a@g.com',
      '1', '2', 'celsius',
      false, // web research
      true, 'ap-1', // apollo + key
      false, false, false, false, false,
    ])
    const a = await runWizard(p, '/repo')
    expect(a.gmailAddress2).toBe('b@g.com')
    expect(a.skills.apollo).toBe(true)
    expect(a.keys.apollo).toBe('ap-1')
  })
})
