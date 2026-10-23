/**
 * tests/onboarding-profile.test.ts
 *
 * Applying the owner profile from the first chat (card #210). The fixture is
 * a real provisional setup: templates copied into a tmp project and written
 * by writeConfiguration, exactly as the web setup leaves a fresh box.
 */
import { describe, it, expect, vi } from 'vitest'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyProfile, skipProfile, RESTART_AFTER_REPLY_KEY } from '../src/onboarding/profile.js'
import { InputError } from '../src/setup/web/answers.js'
import type { Fetch } from '../src/setup/web/telegram.js'
import { writeConfiguration } from '../src/setup/finalize.js'
import { isProfilePending, loadSetupAnswers } from '../src/setup/saved.js'
import { buildEmailSignature, type Answers } from '../src/setup/plan.js'
import { PERSONALITY_PRESETS } from '../src/setup/wizard.js'

const LONDON = { latitude: 51.5072, longitude: -0.1276, country_code: 'GB', name: 'London', timezone: 'Europe/London' }

function fakeFetch(body: unknown = { results: [LONDON] }): Fetch & { calls: number } {
  const f = (async () => {
    f.calls++
    return { json: async () => body } as Response
  }) as unknown as Fetch & { calls: number }
  f.calls = 0
  return f
}

function provisional(root: string, overrides: Partial<Answers> = {}): Answers {
  return {
    ownerName: 'the owner',
    assistantName: 'Atlas',
    timezone: 'America/New_York',
    city: '',
    platform: 'Telegram',
    engine: 'subscription',
    personalityVibe: PERSONALITY_PRESETS[1]!,
    ownerBio: '',
    emailProvider: 'Skip for now',
    emailAddress: '',
    gmailAddress: '',
    gmailAddress2: '',
    outlookAddress: '',
    outlookAddress2: '',
    emailSignature: buildEmailSignature({ name: 'the owner', title: '', phone: '', email: '' }),
    latitude: '40.71',
    longitude: '-74.01',
    tempUnit: 'celsius',
    monthlyAudit: false,
    skills: { webResearch: false, apollo: false, antilibrary: false, notion: false, kanbanzone: false, wordpress: false },
    keys: {},
    projectPath: root,
    ...overrides,
  }
}

function project(overrides: Partial<Answers> = {}): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-profile-'))
  const home = mkdtempSync(join(tmpdir(), 'onboarding-home-'))
  cpSync(resolve(__dirname, '..', 'templates'), join(root, 'templates'), { recursive: true })
  writeConfiguration(provisional(root, overrides), {}, root, home, { profilePending: true })
  return { root, home }
}

const read = (root: string, p: string) => readFileSync(join(root, p), 'utf-8')
const FULL = { ownerName: 'Jane', assistantName: 'Nami', city: 'London', vibe: 'direct' }

describe('applyProfile', () => {
  it('set renders names', async () => {
    const { root, home } = project()
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    const claude = read(root, 'CLAUDE.md')
    expect(claude.startsWith('# Nami')).toBe(true)
    expect(claude).toContain("You are Jane's personal AI assistant")
    const personality = read(root, 'PERSONALITY.md')
    expect(personality).toContain('Your name is Nami')
    expect(personality).toContain(PERSONALITY_PRESETS[2])
    const decision = read(root, 'skills/decision-log/SKILL.md')
    expect(decision).toContain('Jane')
    expect(decision).not.toContain('the owner')
    const weather = read(root, 'skills/weather/manifest.json')
    expect(weather).toContain('51.51')
    expect(weather).toContain('Home is London')
    expect(() => JSON.parse(weather)).not.toThrow()
    expect(res.place).toContain('London')
    expect(res.placeNotFound).toBe(false)
    expect(res.kept).toEqual([])
    expect(res.changed).toContain('CLAUDE.md')
    expect(res.changed).toContain('PERSONALITY.md')
    expect(isProfilePending(root)).toBe(false)
    expect(loadSetupAnswers(root)?.ownerName).toBe('Jane')
  })

  it('set updates TIMEZONE and requests restart', async () => {
    const { root, home } = project()
    writeFileSync(join(root, '.env'), 'TIMEZONE=America/New_York\nFOO=1\n')
    const setState = vi.fn()
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState })
    expect(read(root, '.env')).toBe('TIMEZONE=Europe/London\nFOO=1\n')
    expect(setState).toHaveBeenCalledWith(RESTART_AFTER_REPLY_KEY, expect.any(String))
    expect(RESTART_AFTER_REPLY_KEY).toBe('restart_after_reply')
    expect(res.timezoneChanged).toBe(true)
    expect(res.timezone).toBe('Europe/London')
  })

  it('appends TIMEZONE when .env has none', async () => {
    const { root, home } = project()
    writeFileSync(join(root, '.env'), 'FOO=1')
    await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, '.env')).toBe('FOO=1\nTIMEZONE=Europe/London\n')
  })

  it('same timezone, no restart', async () => {
    const { root, home } = project({ timezone: 'Europe/London' })
    const before = read(root, '.env')
    const setState = vi.fn()
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState })
    expect(setState).not.toHaveBeenCalled()
    expect(res.timezoneChanged).toBe(false)
    expect(read(root, '.env')).toBe(before)
  })

  it('edited personality is kept', async () => {
    const { root, home } = project()
    appendFileSync(join(root, 'PERSONALITY.md'), '\nMy rule.')
    const before = read(root, 'PERSONALITY.md')
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, 'PERSONALITY.md')).toBe(before)
    expect(res.kept).toContain('PERSONALITY.md')
    expect(res.changed).not.toContain('PERSONALITY.md')
  })

  it("leaves the interview's PROFILE.md alone and does not list it as kept", async () => {
    const { root, home } = project()
    writeFileSync(join(root, 'PROFILE.md'), '# About the owner\nReal profile.\n')
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, 'PROFILE.md')).toBe('# About the owner\nReal profile.\n')
    expect(res.kept).not.toContain('PROFILE.md')
    expect(res.changed).not.toContain('PROFILE.md')
  })

  it('city not found', async () => {
    const { root, home } = project()
    writeFileSync(join(root, '.env'), 'TIMEZONE=America/New_York\n')
    const setState = vi.fn()
    const res = await applyProfile(root, home, FULL, { fetch: fakeFetch({}), setState })
    expect(res.placeNotFound).toBe(true)
    expect(res.place).toBeNull()
    expect(read(root, '.env')).toBe('TIMEZONE=America/New_York\n')
    expect(read(root, 'CLAUDE.md')).toContain("You are Jane's personal AI assistant")
    expect(setState).not.toHaveBeenCalled()
    expect(loadSetupAnswers(root)?.city).toBe('London')
    // The old city's coordinates are dropped, so weather never answers for it.
    expect(loadSetupAnswers(root)?.latitude).toBe('')
    expect(read(root, 'skills/weather/manifest.json')).toContain('Home is London. Its coordinates are not saved')
  })

  it('fetch throws', async () => {
    const { root, home } = project()
    writeFileSync(join(root, '.env'), 'TIMEZONE=America/New_York\n')
    const setState = vi.fn()
    const boom = (async () => {
      throw new Error('offline')
    }) as unknown as Fetch
    const res = await applyProfile(root, home, FULL, { fetch: boom, setState })
    expect(res.placeNotFound).toBe(true)
    expect(read(root, '.env')).toBe('TIMEZONE=America/New_York\n')
    expect(read(root, 'CLAUDE.md')).toContain("You are Jane's personal AI assistant")
    expect(setState).not.toHaveBeenCalled()
  })

  it('does not look anything up without a city', async () => {
    const { root, home } = project()
    const f = fakeFetch()
    const res = await applyProfile(root, home, { ownerName: 'Jane' }, { fetch: f, setState: () => {} })
    expect(f.calls).toBe(0)
    expect(res.placeNotFound).toBe(false)
    expect(res.timezoneChanged).toBe(false)
    expect(read(root, 'CLAUDE.md')).toContain("You are Jane's personal AI assistant")
    expect(read(root, 'CLAUDE.md').startsWith('# Atlas')).toBe(true)
  })

  it('not pending skips skills', async () => {
    const { root, home } = project()
    await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    await applyProfile(root, home, { ownerName: 'Jim' }, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, 'skills/decision-log/SKILL.md')).toContain('Jane')
    expect(read(root, 'skills/decision-log/SKILL.md')).not.toContain('Jim')
    expect(read(root, 'CLAUDE.md')).toContain("You are Jim's personal AI assistant")
    // An unedited personality file still follows the rename.
    expect(read(root, 'PERSONALITY.md')).toContain("Jim's digital right hand")
  })

  it('rebuilds the signature only when it was the default one', async () => {
    const { root, home } = project()
    await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(loadSetupAnswers(root)?.emailSignature).toBe(buildEmailSignature({ name: 'Jane', title: '', phone: '', email: '' }))
    const custom = project({ emailSignature: 'Custom sig' })
    await applyProfile(custom.root, custom.home, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(loadSetupAnswers(custom.root)?.emailSignature).toBe('Custom sig')
  })

  it('accepts a custom vibe and refuses a long one', async () => {
    const { root, home } = project()
    await applyProfile(root, home, { vibe: 'Calm and dry.' }, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, 'PERSONALITY.md')).toContain('**Vibe:** Calm and dry.')
    await expect(applyProfile(root, home, { vibe: 'x'.repeat(301) }, { fetch: fakeFetch() })).rejects.toThrow(InputError)
  })

  it('rejects quotes', async () => {
    const { root, home } = project()
    await expect(applyProfile(root, home, { ownerName: 'Ja"ne' }, { fetch: fakeFetch(), setState: () => {} })).rejects.toThrow(InputError)
    await expect(applyProfile(root, home, { assistantName: 'x'.repeat(41) }, { fetch: fakeFetch() })).rejects.toThrow(InputError)
    await expect(applyProfile(root, home, { ownerName: '  ' }, { fetch: fakeFetch() })).rejects.toThrow(InputError)
  })

  it('no saved setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-profile-'))
    await expect(applyProfile(root, root, FULL, { fetch: fakeFetch() })).rejects.toThrow(InputError)
    await expect(applyProfile(root, root, FULL, { fetch: fakeFetch() })).rejects.toThrow(
      'This assistant was set up before profile changes were possible here. Edit CLAUDE.md and PERSONALITY.md directly.'
    )
  })

  it('secrets never written', async () => {
    const keys = { perplexity: 'pplx-real-secret', apollo: 'apollo-secret', notion: 'ntn-secret', kanbanzone: 'kz-secret', wpAppPassword: 'wp-secret' }
    const { root, home } = project({
      skills: { webResearch: true, apollo: true, antilibrary: false, notion: true, kanbanzone: true, wordpress: true },
      keys,
    })
    // The setup run wrote the real secrets into its home; set gets a fresh one.
    expect(readFileSync(join(home, '.perplexity-api-key'), 'utf-8')).toBe('pplx-real-secret')
    const setHome = mkdtempSync(join(tmpdir(), 'onboarding-home-'))
    await applyProfile(root, setHome, FULL, { fetch: fakeFetch(), setState: () => {} })
    expect(readdirSync(setHome)).toEqual([])
    const answersFile = read(root, 'store/setup-answers.json')
    for (const secret of Object.values(keys)) expect(answersFile).not.toContain(secret)
  })

  it('a pending set keeps the WordPress and Anti-library config', async () => {
    const { root, home } = project({
      skills: { webResearch: false, apollo: false, antilibrary: true, notion: false, kanbanzone: false, wordpress: true },
      keys: { wpSiteUrl: 'https://example.com', wpUsername: 'jane', obsidianVaultPath: '/vaults/notes' },
    })
    expect(read(root, 'skills/wordpress/wp-api.mjs')).toContain("const SITE = 'https://example.com'")
    await applyProfile(root, home, { ownerName: 'Jane' }, { fetch: fakeFetch(), setState: () => {} })
    expect(read(root, 'skills/wordpress/wp-api.mjs')).toContain("const SITE = 'https://example.com'")
    expect(read(root, 'skills/wordpress/wp-api.mjs')).toContain('jane')
    expect(read(root, 'skills/antilibrary/SKILL.md')).toContain('/vaults/notes')
    expect(loadSetupAnswers(root)?.skillConfig).toEqual({ wpSiteUrl: 'https://example.com', wpUsername: 'jane', obsidianVaultPath: '/vaults/notes' })
  })

  it('requests the restart only after the answers are saved', async () => {
    const { root, home } = project()
    writeFileSync(join(root, '.env'), 'TIMEZONE=America/New_York\n')
    let pendingAtRestart: boolean | undefined
    await applyProfile(root, home, FULL, { fetch: fakeFetch(), setState: () => (pendingAtRestart = isProfilePending(root)) })
    expect(pendingAtRestart).toBe(false)
  })
})

describe('skipProfile', () => {
  it('skipProfile clears flag only', () => {
    const { root } = project()
    const claude = read(root, 'CLAUDE.md')
    const before = loadSetupAnswers(root)
    skipProfile(root)
    expect(read(root, 'CLAUDE.md')).toBe(claude)
    expect(isProfilePending(root)).toBe(false)
    expect({ ...loadSetupAnswers(root), profilePending: true }).toEqual(before)
  })

  it('does nothing without a saved setup', () => {
    const root = mkdtempSync(join(tmpdir(), 'onboarding-profile-'))
    skipProfile(root)
    expect(existsSync(join(root, 'store'))).toBe(false)
  })
})
