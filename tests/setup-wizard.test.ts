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
import { runWizard, provisionalAssistantName, PERSONALITY_PRESETS, type Prompter } from '../src/setup/wizard.js'
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
  skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
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

  it('emits slack keys for slack installs (wordsmith no longer needs a separate key)', () => {
    const env = buildEnvContent({
      ...BASE,
      platform: 'Slack',
      skills: { ...BASE.skills },
      keys: {},
    })
    expect(env).toContain('SLACK_BOT_TOKEN=')
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

  it('writes a voice OpenAI key on a Claude install, labelled for voice', () => {
    const env = buildEnvContent({ ...BASE, keys: { openai: 'sk-voice' } })
    expect(env).toMatch(/^OPENAI_API_KEY=sk-voice$/m)
    expect(env).toMatch(/# Voice: voice notes, spoken replies, and live conversation/)
  })

  it('writes an empty voice key line to fill in later when voice was enabled without one', () => {
    const env = buildEnvContent({ ...BASE, keys: { openai: '' } })
    expect(env).toMatch(/^OPENAI_API_KEY=$/m)
  })

  it('writes no OpenAI key when voice was declined', () => {
    expect(buildEnvContent({ ...BASE, keys: {} })).not.toMatch(/OPENAI_API_KEY/)
  })

  it('writes OPENAI_API_KEY once when OpenAI is also the model provider', () => {
    const env = buildEnvContent({ ...BASE, engine: 'api-key', aiProvider: 'openai', aiModel: 'gpt-5', keys: { openai: 'sk-o' } })
    expect(env.match(/^OPENAI_API_KEY=/gm)?.length).toBe(1)
  })

  it('writes GOOGLE_API_KEY once when Gemini is the model provider', () => {
    const env = buildEnvContent({
      ...BASE,
      engine: 'api-key',
      aiProvider: 'google',
      aiModel: 'gemini-2.5-pro',
      skills: { ...BASE.skills },
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

  it('writes the personality once and regenerates CLAUDE.md around it', () => {
    const plan = buildSkillPlan(BASE, '/home/sam')
    type Template = Extract<ReturnType<typeof buildSkillPlan>[number], { type: 'template' }>
    const personality = plan.find((a) => a.type === 'template' && a.to === 'PERSONALITY.md') as Template
    const claudeMd = plan.find((a) => a.type === 'template' && a.to === 'CLAUDE.md') as Template

    // The owner's edits live in PERSONALITY.md, so a re-run must not rewrite it.
    expect(personality.onlyIfMissing).toBe(true)
    expect(personality.vars.PERSONALITY_VIBE).toBe('Direct.')
    // CLAUDE.md is safe to regenerate precisely because the vibe moved out of it.
    expect(claudeMd.onlyIfMissing).toBeUndefined()
    expect(claudeMd.vars.PERSONALITY_VIBE).toBeUndefined()
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

  it('gives each outlook SKILL.md its own address and the install path its commands live under', () => {
    const plan = buildSkillPlan(
      { ...BASE, emailProvider: 'Outlook/Microsoft 365', outlookAddress: 'a@co.com', outlookAddress2: 'b@co.com', emailAddress: 'a@co.com' },
      '/home/sam'
    )
    const primary = plan.find((a) => a.type === 'edit' && a.file === 'skills/outlook/SKILL.md')!
    const secondary = plan.find((a) => a.type === 'edit' && a.file === 'skills/outlook-secondary/SKILL.md')!
    expect(primary.vars).toEqual({ EMAIL_ADDRESS: 'a@co.com', PROJECT_PATH: BASE.projectPath })
    expect(secondary.vars).toEqual({ EMAIL_ADDRESS: 'b@co.com', PROJECT_PATH: BASE.projectPath })
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

/** Rejects every request, so the city lookup falls back and no test touches the network. */
const offline = (async () => {
  throw new Error('offline')
}) as unknown as typeof fetch

/** Platform + engine are always first; `rest` is everything after. */
const NO_EXTRAS = [false, false] // email gate, optional-skills gate
const ALL_SKILLS_OFF = [false, false, false, false, false, false, false] // six skills + voice

describe('runWizard', () => {
  it('fresh install asks only core', async () => {
    const asked: string[] = []
    const inner = scripted(['Telegram', 0, ...NO_EXTRAS])
    const p: Prompter = {
      ...inner,
      ask: async (q, d) => (asked.push(q), inner.ask(q, d)),
      choice: async (q, o) => (asked.push(q), inner.choice(q, o)),
      yesNo: async (q) => (asked.push(q), inner.yesNo(q)),
    }
    const a = await runWizard(p, '/repo', undefined, { hostTimezone: 'America/Halifax' })
    for (const banned of ['Your name', 'Latitude', 'Longitude', 'Perplexity', 'Monthly audit', 'timezone']) {
      expect(asked.some((q) => q.includes(banned))).toBe(false)
    }
    expect(a.ownerName).toBe('the owner')
    expect(a.assistantName).toBe('Atlas')
    expect(a.timezone).toBe('America/Halifax')
    expect(a.latitude).toBe('40.71')
    expect(a.tempUnit).toBe('celsius')
    expect(a.personalityVibe).toBe(PERSONALITY_PRESETS[1])
    expect(a.monthlyAudit).toBe(false)
    expect(a.platform).toBe('Telegram')
    expect(a.engine).toBe('subscription')
    expect(a.emailProvider).toBe('Skip for now')
    expect(Object.values(a.skills).every((v) => v === false)).toBe(true)
  })

  it('uses UTC when no host timezone is given', async () => {
    const a = await runWizard(scripted(['Telegram', 0, ...NO_EXTRAS]), '/repo')
    expect(a.timezone).toBe('UTC')
  })

  it('legacy install asks profile', async () => {
    const asked: string[] = []
    const inner = scripted(['Telegram', 0, 'Jane', 'Ada', 'Toronto', 2, 'Consultant.', ...NO_EXTRAS])
    const p: Prompter = {
      ...inner,
      ask: async (q, d) => (asked.push(q), inner.ask(q, d)),
      choice: async (q, o) => (asked.push(q), inner.choice(q, o)),
      yesNo: async (q) => (asked.push(q), inner.yesNo(q)),
    }
    const a = await runWizard(p, '/repo', undefined, { legacyInstall: true, fetch: offline, hostTimezone: 'America/Toronto' })
    expect(asked).toContain('Your name')
    expect(asked.some((q) => q.includes('Latitude') || q.includes('Longitude') || q.includes('timezone'))).toBe(false)
    expect(a.ownerName).toBe('Jane')
    expect(a.assistantName).toBe('Ada')
    expect(a.city).toBe('Toronto')
    expect(a.personalityVibe).toContain('Direct')
    expect(a.ownerBio).toBe('Consultant.')
    expect(a.timezone).toBe('America/Toronto')
    expect(a.latitude).toBe('40.71')
  })

  it('legacy install takes timezone, coordinates and unit from the city lookup', async () => {
    const f = (async () => ({
      json: async () => ({
        results: [{ latitude: 43.65, longitude: -79.38, country_code: 'CA', name: 'Toronto', admin1: 'Ontario', country: 'Canada', timezone: 'America/Toronto' }],
      }),
    })) as unknown as typeof fetch
    const a = await runWizard(scripted(['Telegram', 0, 'Jane', 'Atlas', 'Toronto', 0, 'Bio', ...NO_EXTRAS]), '/repo', undefined, {
      legacyInstall: true,
      fetch: f,
      hostTimezone: 'UTC',
    })
    expect(a.timezone).toBe('America/Toronto')
    expect(a.latitude).toBe('43.65')
    expect(a.longitude).toBe('-79.38')
  })

  it('legacy install re-asks a blank or unsafe name', async () => {
    for (const bad of ['', 'Ja"ne']) {
      const a = await runWizard(scripted(['Telegram', 0, bad, 'Jane', 'Atlas', 'Toronto', 0, 'Bio', ...NO_EXTRAS]), '/repo', undefined, {
        legacyInstall: true,
        fetch: offline,
      })
      expect(a.ownerName).toBe('Jane')
    }
  })

  it('legacy install re-asks an unsafe assistant name and city, and a bad bio', async () => {
    const a = await runWizard(
      scripted(['Telegram', 0, 'Jane', 'A\\b', 'Ada', 'To"ronto', 'Toronto', 0, 'x'.repeat(601), 'Bio', ...NO_EXTRAS]),
      '/repo',
      undefined,
      { legacyInstall: true, fetch: offline }
    )
    expect(a.assistantName).toBe('Ada')
    expect(a.city).toBe('Toronto')
    expect(a.ownerBio).toBe('Bio')
  })

  it('provisionalAssistantName keeps a valid bot name and falls back to Atlas', () => {
    expect(provisionalAssistantName('Umi')).toBe('Umi')
    for (const bad of ['Um"i', 'Um\\i', 'x'.repeat(41), '', undefined]) expect(provisionalAssistantName(bad)).toBe('Atlas')
  })

  it('saved answers reused', async () => {
    const saved = { ...BASE, ownerName: 'Jane', profilePending: false, version: 1 as const }
    const asked: string[] = []
    const inner = scripted(['Telegram', 0, ...NO_EXTRAS])
    const p: Prompter = { ...inner, ask: async (q, d) => (asked.push(q), inner.ask(q, d)) }
    const a = await runWizard(p, '/repo', undefined, { saved })
    expect(asked).not.toContain('Your name')
    expect(a.ownerName).toBe('Jane')
    expect(a.city).toBe('Toronto')
    expect(a.timezone).toBe('America/Toronto')
  })

  it('email behind gate', async () => {
    const a = await runWizard(scripted(['Telegram', 0, true, 'Gmail', 'a@g.com', false, false]), '/repo')
    expect(a.gmailAddress).toBe('a@g.com')
    expect(a.emailSignature).toContain('a@g.com')
  })

  it('optional behind gate', async () => {
    const asked: string[] = []
    const inner = scripted(['Telegram', 0, false, true, true, 'pplx-1', ...ALL_SKILLS_OFF.slice(1)])
    const p: Prompter = { ...inner, ask: async (q, d) => (asked.push(q), inner.ask(q, d)) }
    const a = await runWizard(p, '/repo')
    expect(asked.some((q) => q.includes('Perplexity'))).toBe(true)
    expect(a.keys.perplexity).toBe('pplx-1')
  })

  it('collects secondary gmail and apollo key when opted in', async () => {
    const a = await runWizard(
      scripted([
        'Telegram', 0,
        true, 'Gmail', 'a@g.com', true, 'b@g.com', // email gate, gmail + secondary
        true, // optional skills gate
        false, // web research
        true, 'ap-1', // apollo + key
        false, false, false, false, false, // antilibrary, notion, kanban zone, voice, wordpress
      ]),
      '/repo'
    )
    expect(a.gmailAddress2).toBe('b@g.com')
    expect(a.skills.apollo).toBe(true)
    expect(a.keys.apollo).toBe('ap-1')
  })

  it('asks for a model id when the provider has no default, and not when it does', async () => {
    const anthropic = await runWizard(scripted(['Telegram', 1, 0, 'sk-a', ...NO_EXTRAS]), '/repo')
    expect(anthropic.engine).toBe('api-key')
    expect(anthropic.aiProvider).toBe('anthropic')
    expect(anthropic.keys.anthropic).toBe('sk-a')

    const openai = await runWizard(scripted(['Telegram', 1, 1, 'sk-o', 'gpt-5', ...NO_EXTRAS]), '/repo')
    expect(openai.aiProvider).toBe('openai')
    expect(openai.keys.openai).toBe('sk-o')
    expect(openai.aiModel).toBe('gpt-5')
  })

  it('no longer asks a Wordsmith question (skill is always-on)', async () => {
    // The scripted prompter throws if extra questions appear.
    const a = await runWizard(
      scripted([
        'Telegram', 1, 2, 'g-1', 'gemini-2.5-pro', // engine -> Google -> key -> model
        false, true, // email gate, optional gate
        false, false, // web research, apollo
        false, false, false, // antilibrary, notion, kanban zone
        false, // voice
        false, // wordpress
      ]),
      '/repo'
    )
    expect(a.keys.google).toBe('g-1')
  })

  it('offers voice on a Claude install and stores the OpenAI key', async () => {
    const a = await runWizard(
      scripted([
        'Telegram', 0,
        false, true,
        false, false, false, false, false, // web research, apollo, antilibrary, notion, kanban zone
        true, 'sk-voice', // voice -> key
        false, // wordpress
      ]),
      '/repo'
    )
    expect(a.keys.openai).toBe('sk-voice')
  })

  it('leaves the OpenAI key unset when voice is declined', async () => {
    const a = await runWizard(scripted(['Telegram', 0, false, true, ...ALL_SKILLS_OFF]), '/repo')
    expect(a.keys.openai).toBeUndefined()
  })

  it('does not ask for voice again when OpenAI is already the model provider', async () => {
    const asked: string[] = []
    const inner = scripted(['Telegram', 1, 1, 'sk-o', 'gpt-5', false, true, false, false, false, false, false, false])
    const a = await runWizard({ ...inner, yesNo: async (q) => (asked.push(q), inner.yesNo(q)) }, '/repo')
    expect(asked).not.toContain('Enable voice?')
    expect(a.keys.openai).toBe('sk-o')
  })

  it('tells the owner whether live conversation will work on this Node version', async () => {
    const { liveNodeNote } = await import('../src/setup/wizard.js')
    expect(liveNodeNote('22.23.2')).toMatch(/live conversation will all work/)
    expect(liveNodeNote('20.20.2')).toMatch(/needs Node 22/)
    expect(liveNodeNote('20.20.2')).toMatch(/Node 20\.20\.2/)
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

  it('signs in right after the engine question, before email', async () => {
    const order: string[] = []
    const p = recording(scripted(['Telegram', 0, ...NO_EXTRAS]), order)
    await runWizard(p, '/repo', { signIn: async () => void order.push('SIGN-IN') })

    const engine = order.findIndex((s) => s.startsWith('choice:Which do you have?'))
    const signIn = order.indexOf('SIGN-IN')
    const nextQuestion = order.findIndex((s) => s.includes('Connect email'))
    expect(engine).toBeGreaterThanOrEqual(0)
    expect(signIn).toBe(engine + 1)
    expect(signIn).toBeLessThan(nextQuestion)
  })

  it('does not try to sign in on the API-key or deferred paths', async () => {
    const signIn = async () => {
      throw new Error('sign-in must not run: neither path uses a Claude account')
    }
    await runWizard(scripted(['Telegram', 1, 0, 'sk-a', ...NO_EXTRAS]), '/repo', { signIn })
    await runWizard(scripted(['Telegram', 2, ...NO_EXTRAS]), '/repo', { signIn })
  })

  it('checks for the gog CLI right after a Gmail address is given', async () => {
    const order: string[] = []
    const p = recording(scripted(['Telegram', 0, true, 'Gmail', 'a@g.com', false, false]), order)
    await runWizard(p, '/repo', { ensureGog: async () => void order.push('GOG-CHECK') })

    const gmail = order.findIndex((s) => s === 'ask:Gmail address')
    const check = order.indexOf('GOG-CHECK')
    const optional = order.findIndex((s) => s.includes('optional skills'))
    expect(gmail).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(gmail)
    expect(check).toBeLessThan(optional)
  })

  it('does not run the gog check when Gmail is skipped or Outlook-only', async () => {
    const ensureGog = async () => {
      throw new Error('gog check must not run without a Gmail account')
    }
    await runWizard(scripted(['Telegram', 0, ...NO_EXTRAS]), '/repo', { ensureGog })
    await runWizard(scripted(['Telegram', 0, true, 'Outlook/Microsoft 365', 'a@o.com', false, false]), '/repo', { ensureGog })
  })

  it('records a deferred choice rather than pretending it was answered', async () => {
    const a = await runWizard(scripted(['Telegram', 2, ...NO_EXTRAS]), '/repo')
    expect(a.engine).toBe('later')
    expect(a.aiProvider).toBeUndefined()
  })
})
