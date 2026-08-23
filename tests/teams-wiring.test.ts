import { describe, it, expect, vi, afterEach } from 'vitest'

const envState: { env: Record<string, string> } = { env: {} }
vi.mock('../src/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, readEnvFile: () => envState.env }
})

import { detectPlatform, createAdapter } from '../src/platform/index.js'
import { buildEnvContent } from '../src/setup/plan.js'

afterEach(() => {
  envState.env = {}
})

describe('Teams platform wiring', () => {
  it('auto-detects teams from its credentials, after slack, before telegram', () => {
    envState.env = { TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's', TELEGRAM_BOT_TOKEN: 't' }
    expect(detectPlatform()).toBe('teams')
    envState.env = { TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's', SLACK_BOT_TOKEN: 'b', SLACK_APP_TOKEN: 'x' }
    expect(detectPlatform()).toBe('slack')
    envState.env = { TEAMS_APP_ID: 'a' }
    expect(detectPlatform()).toBe('telegram')
  })

  it('creates a TeamsAdapter when credentials are present and explains when they are not', async () => {
    envState.env = { PLATFORM: 'teams', TEAMS_APP_ID: 'a', TEAMS_APP_SECRET: 's' }
    const adapter = await createAdapter()
    expect(adapter.name).toBe('teams')
    envState.env = { PLATFORM: 'teams', TEAMS_APP_ID: 'a' }
    await expect(createAdapter()).rejects.toThrow(/TEAMS_APP_ID and TEAMS_APP_SECRET/)
  })

  it('writes the four Teams keys into a fresh .env', () => {
    const env = buildEnvContent({
      ownerName: 'Marc', assistantName: 'Nami', timezone: 'America/Toronto', city: 'Toronto',
      platform: 'Teams', engine: 'later', personalityVibe: 'Direct', ownerBio: 'x',
      emailProvider: 'Skip for now', gmailAddress: '', gmailAddress2: '', outlookAddress: '', outlookAddress2: '',
      emailSignature: '', latitude: '0', longitude: '0', tempUnit: 'celsius',
      keys: {}, skills: { webResearch: false, apollo: false, wordsmith: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    } as never)
    for (const k of ['TEAMS_APP_ID=', 'TEAMS_APP_SECRET=', 'TEAMS_TENANT_ID=', 'ALLOWED_CHAT_ID=']) expect(env).toContain(k)
  })
})
