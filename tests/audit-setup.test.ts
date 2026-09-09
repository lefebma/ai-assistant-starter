import { describe, it, expect } from 'vitest'
import { runWizard, type Prompter } from '../src/setup/wizard.js'
import { buildEnvContent, type Answers } from '../src/setup/plan.js'
import { auditWanted } from '../src/audit/schedule.js'

/** Answers every question with the default, so only the yes/no under test moves. */
function scriptedPrompter(yesNo: (q: string) => boolean): Prompter {
  return {
    say: () => {},
    ask: async (_q, def) => def ?? 'x',
    choice: async (_q, options) => options[0]!,
    yesNo: async (q) => yesNo(q),
  }
}

function baseAnswers(overrides: Partial<Answers> = {}): Answers {
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
    skills: {
      webResearch: false,
      apollo: false,
      antilibrary: false,
      notion: false,
      kanbanzone: false,
      wordpress: false,
    },
    keys: {},
    projectPath: '/tmp/x',
    ...overrides,
  } as Answers
}

describe('the setup question (card 123, AC1)', () => {
  it('asks whether to schedule the monthly audit', async () => {
    const asked: string[] = []
    await runWizard(
      scriptedPrompter((q) => {
        asked.push(q)
        return false
      }),
      '/tmp/x'
    )
    expect(asked.some((q) => /monthly/i.test(q) && /audit|review|check/i.test(q))).toBe(true)
  })

  it('records a yes', async () => {
    const answers = await runWizard(scriptedPrompter((q) => /monthly/i.test(q)), '/tmp/x')
    expect(answers.monthlyAudit).toBe(true)
  })

  it('records a no', async () => {
    const answers = await runWizard(scriptedPrompter(() => false), '/tmp/x')
    expect(answers.monthlyAudit).toBe(false)
  })
})

describe('buildEnvContent', () => {
  it('writes a setting the runtime reads back as on', () => {
    const env = buildEnvContent(baseAnswers({ monthlyAudit: true }))
    expect(env).toMatch(/^MONTHLY_AUDIT=/m)
    const value = /^MONTHLY_AUDIT=(.*)$/m.exec(env)?.[1]
    expect(auditWanted({ MONTHLY_AUDIT: value })).toBe(true)
  })

  it('writes a setting the runtime reads back as off', () => {
    const env = buildEnvContent(baseAnswers({ monthlyAudit: false }))
    const value = /^MONTHLY_AUDIT=(.*)$/m.exec(env)?.[1]
    expect(auditWanted({ MONTHLY_AUDIT: value })).toBe(false)
  })
})
