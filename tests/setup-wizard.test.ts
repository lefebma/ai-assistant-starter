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
  engine: 'subscription',
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

  it('leaves the runtime at its default on a subscription install', () => {
    const env = buildEnvContent(BASE)
    // Commented guidance is fine; an active AGENT_RUNTIME line is not, since
    // the subscription path is exactly the default.
    expect(env).not.toMatch(/^AGENT_RUNTIME=/m)
    expect(env).toMatch(/# AGENT_RUNTIME=ai-sdk/)
  })

  it('wires the ai-sdk runtime and the key for an API-key install', () => {
    const env = buildEnvContent({ ...BASE, engine: 'api-key', aiProvider: 'anthropic', keys: { anthropic: 'sk-a' } })
    expect(env).toMatch(/^AGENT_RUNTIME=ai-sdk$/m)
    expect(env).toMatch(/^AI_PROVIDER=anthropic$/m)
    expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-a$/m)
  })

  it('carries the model id for providers that have no default', () => {
    const env = buildEnvContent({ ...BASE, engine: 'api-key', aiProvider: 'openai', aiModel: 'gpt-5', keys: { openai: 'sk-o' } })
    expect(env).toMatch(/^AI_MODEL=gpt-5$/m)
    expect(env).toMatch(/^OPENAI_API_KEY=sk-o$/m)
  })

  it('flags a missing model id for a provider that requires one', () => {
    const env = buildEnvContent({ ...BASE, engine: 'api-key', aiProvider: 'google', keys: { google: 'g-1' } })
    expect(env).toMatch(/AI_MODEL is REQUIRED/)
  })

  it('never writes GOOGLE_API_KEY twice when Gemini is both the model and Wordsmith', () => {
    // Two lines with the same name is not a harmless duplicate: the later one
    // silently wins, so a blank Wordsmith answer would erase the model key.
    const env = buildEnvContent({
      ...BASE,
      engine: 'api-key',
      aiProvider: 'google',
      aiModel: 'gemini-2.5-pro',
      skills: { ...BASE.skills, wordsmith: true },
      keys: { google: 'g-1' },
    })
    expect(env.match(/^GOOGLE_API_KEY=/gm)).toHaveLength(1)
    expect(env).toMatch(/^GOOGLE_API_KEY=g-1$/m)
  })

  it('spells out both options when the owner defers the choice', () => {
    const env = buildEnvContent({ ...BASE, engine: 'later' })
    expect(env).toMatch(/NOT CONFIGURED YET/)
    expect(env).toMatch(/Pro or Max/)
    expect(env).toMatch(/# ANTHROPIC_API_KEY=/)
    expect(env).not.toMatch(/^AGENT_RUNTIME=/m)
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
      0, // engine: Claude subscription
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
    expect(a.engine).toBe('subscription')
    expect(a.personalityVibe).toContain('Direct')
    expect(a.emailProvider).toBe('Skip for now')
    expect(Object.values(a.skills).every((v) => v === false)).toBe(true)
  })

  it('collects secondary gmail and apollo key when opted in', async () => {
    const p = scripted([
      'Sam', 'Atlas', 'America/Toronto', 'Toronto',
      'Telegram',
      0, // engine
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

  const tail = (extra: Array<string | boolean | number> = []) => [
    0, // preset
    'Bio',
    'Skip for now',
    'Sam', '', '', '',
    '1', '2', 'celsius',
    ...extra,
  ]

  it('asks for a model id when the provider has no default, and not when it does', async () => {
    const anthropic = await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        1, 0, 'sk-a', // engine: API key -> Anthropic -> key (no model question)
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo'
    )
    expect(anthropic.engine).toBe('api-key')
    expect(anthropic.aiProvider).toBe('anthropic')
    expect(anthropic.keys.anthropic).toBe('sk-a')

    const openai = await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        1, 1, 'sk-o', 'gpt-5', // engine -> OpenAI -> key -> model
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo'
    )
    expect(openai.aiProvider).toBe('openai')
    expect(openai.keys.openai).toBe('sk-o')
    expect(openai.aiModel).toBe('gpt-5')
  })

  it('does not ask for the same Google key twice when Wordsmith is also on', async () => {
    // scripted() throws if the wizard asks more questions than were scripted,
    // so a second Google prompt fails this test rather than silently passing.
    const a = await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        1, 2, 'g-1', 'gemini-2.5-pro', // engine -> Google -> key -> model
        ...tail([
          false, // web research
          false, // apollo
          true, //  wordsmith enabled, key already known
          false, false, false, false,
        ]),
      ]),
      '/repo'
    )
    expect(a.skills.wordsmith).toBe(true)
    expect(a.keys.google).toBe('g-1')
  })

  /** Wraps a scripted prompter to record the order questions were asked in. */
  function recording(inner: Prompter, log: string[]): Prompter {
    return {
      ask: async (q, d) => (log.push(`ask:${q}`), inner.ask(q, d)),
      choice: async (q, o) => (log.push(`choice:${q}`), inner.choice(q, o)),
      yesNo: async (q) => (log.push(`yesNo:${q}`), inner.yesNo(q)),
      say: () => {},
    }
  }

  it('signs in right after the engine question, not fifteen questions later', async () => {
    const order: string[] = []
    const p = recording(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        0, // engine: subscription
        ...tail([false, false, false, false, false, false, false]),
      ]),
      order
    )
    await runWizard(p, '/repo', { signIn: async () => void order.push('SIGN-IN') })

    const engine = order.findIndex((s) => s.startsWith('choice:Which do you have?'))
    const signIn = order.indexOf('SIGN-IN')
    const nextQuestion = order.findIndex((s) => s.includes('communicate'))
    expect(engine).toBeGreaterThanOrEqual(0)
    expect(signIn).toBe(engine + 1)
    expect(signIn).toBeLessThan(nextQuestion)
  })

  it('does not try to sign in on the API-key or deferred paths', async () => {
    const signIn = async () => {
      throw new Error('sign-in must not run: neither path uses a Claude account')
    }
    await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        1, 0, 'sk-a',
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo',
      { signIn }
    )
    await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        2,
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo',
      { signIn }
    )
  })

  it('checks for the gog CLI right after a Gmail address is given', async () => {
    const order: string[] = []
    const p = recording(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        0, // engine: subscription
        0, 'Bio',
        'Gmail', 'a@g.com', false, // gmail, no second account
        'Sam', '', '', 'a@g.com',
        '1', '2', 'celsius',
        false, false, false, false, false, false, false,
      ]),
      order
    )
    await runWizard(p, '/repo', { ensureGog: async () => void order.push('GOG-CHECK') })

    const gmail = order.findIndex((s) => s === 'ask:Gmail address')
    const check = order.indexOf('GOG-CHECK')
    const signature = order.findIndex((s) => s.includes('signature'))
    expect(gmail).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(gmail)
    expect(check).toBeLessThan(signature)
  })

  it('does not run the gog check when Gmail is skipped or Outlook-only', async () => {
    const ensureGog = async () => {
      throw new Error('gog check must not run without a Gmail account')
    }
    await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        0,
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo',
      { ensureGog }
    )
    await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        0, 0, 'Bio',
        'Outlook/Microsoft 365', 'a@o.com', false,
        'Sam', '', '', 'a@o.com',
        '1', '2', 'celsius',
        false, false, false, false, false, false, false,
      ]),
      '/repo',
      { ensureGog }
    )
  })

  it('records a deferred choice rather than pretending it was answered', async () => {
    const a = await runWizard(
      scripted([
        'Sam', 'Atlas', 'America/Toronto', 'Toronto', 'Telegram',
        2, // engine: neither yet
        ...tail([false, false, false, false, false, false, false]),
      ]),
      '/repo'
    )
    expect(a.engine).toBe('later')
    expect(a.aiProvider).toBeUndefined()
  })
})
