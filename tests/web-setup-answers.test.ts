import { describe, it, expect } from 'vitest'
import { answersFromWeb, InputError, lookUpCity, parseEngine, parseTimezone, provisionalProfile, validName } from '../src/setup/web/answers.js'
import type { Fetch } from '../src/setup/web/telegram.js'
import { PERSONALITY_PRESETS } from '../src/setup/wizard.js'
import { renderEnv } from '../src/setup/finalize.js'
import { buildCaddyfile } from '../src/deploy/teams-edge.js'
import { buildHandoffPath, buildHandoffService, buildSetupUnit, UNIT_LOGS } from '../src/deploy/setup-edge.js'

const PROFILE = provisionalProfile('Leif Becker', 'Avery', 'America/Toronto')

describe('provisionalProfile', () => {
  it('takes the first word of the pairing name and the bot name, with the friendly tone and no city', () => {
    expect(provisionalProfile('Jane Doe', 'Nami', 'Europe/London')).toEqual({
      ownerName: 'Jane',
      assistantName: 'Nami',
      timezone: 'Europe/London',
      city: '',
      vibe: 1,
      ownerBio: '',
    })
  })
  it('falls back when the pairing name or bot name is unusable', () => {
    expect(provisionalProfile('Ja"ne', undefined, 'UTC')).toMatchObject({ ownerName: 'the owner', assistantName: 'Atlas' })
    expect(provisionalProfile('', undefined, 'UTC').ownerName).toBe('the owner')
    expect(provisionalProfile('Unknown', undefined, 'UTC').ownerName).toBe('the owner')
    expect(provisionalProfile('Jane', 'Bad\\Name', 'UTC').assistantName).toBe('Atlas')
    expect(provisionalProfile('Jane', 'x'.repeat(41), 'UTC').assistantName).toBe('Atlas')
  })
})

describe('parseTimezone', () => {
  it('keeps a real timezone and falls back to UTC otherwise', () => {
    expect(parseTimezone('America/Toronto')).toBe('America/Toronto')
    expect(parseTimezone('Not/AZone')).toBe('UTC')
    expect(parseTimezone('UTC; rm -rf /')).toBe('UTC')
    expect(parseTimezone(undefined)).toBe('UTC')
    expect(parseTimezone(42)).toBe('UTC')
  })
})

describe('parseEngine', () => {
  it('fills a default model for providers that need one', () => {
    expect(parseEngine({ kind: 'api-key', provider: 'openai', key: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }, false)).toMatchObject({ model: 'gpt-5' })
    expect(parseEngine({ kind: 'api-key', provider: 'anthropic', key: 'sk-ant-abcdefghijklmnopqrstuvwxyz' }, false)).toMatchObject({ model: '' })
  })
  it('refuses a key that is not shaped like one, and never puts it in the message', () => {
    expect(() => parseEngine({ kind: 'api-key', provider: 'openai', key: 'oops my key' }, false)).toThrow(/does not look right/)
    try {
      parseEngine({ kind: 'api-key', provider: 'openai', key: 'oops my key' }, false)
    } catch (e) {
      expect((e as Error).message).not.toContain('oops')
    }
  })
  it('only allows the subscription where it is offered', () => {
    expect(() => parseEngine({ kind: 'subscription' }, false)).toThrow(/not available/)
    expect(parseEngine({ kind: 'subscription' }, true).kind).toBe('subscription')
  })
})

describe('managed engine', () => {
  it('is never accepted from a request body', () => {
    expect(() => parseEngine({ kind: 'managed' }, true)).toThrow(InputError)
  })

  it('carries through answersFromWeb with no provider or model', () => {
    const a = answersFromWeb(PROFILE, { kind: 'managed' }, null, '/p')
    expect(a.engine).toBe('managed')
    expect(a.aiProvider).toBeUndefined()
    expect(a.aiModel).toBeUndefined()
  })
})

describe('answersFromWeb', () => {
  it('maps to the answers a skip-everything wizard run gives, with no secrets', () => {
    const a = answersFromWeb(PROFILE, { kind: 'api-key', provider: 'openai', model: 'gpt-5' }, { latitude: '43.70', longitude: '-79.42', tempUnit: 'celsius', label: 'Toronto' }, '/p')
    expect(a).toMatchObject({
      platform: 'Telegram',
      engine: 'api-key',
      aiProvider: 'openai',
      personalityVibe: PERSONALITY_PRESETS[1],
      emailProvider: 'Skip for now',
      latitude: '43.70',
      monthlyAudit: false,
      keys: {},
    })
    const env = renderEnv(a, { chatId: '42' })
    expect(env).toMatch(/^OPENAI_API_KEY=$/m)
    expect(env).toMatch(/^TELEGRAM_BOT_TOKEN=$/m)
    expect(env).toMatch(/^ALLOWED_CHAT_ID=42$/m)
  })
  it('leaves the coordinates empty when the city lookup fails, never a made-up city', () => {
    const a = answersFromWeb(PROFILE, { kind: 'later' }, null, '/p')
    expect([a.latitude, a.longitude]).toEqual(['', ''])
  })
})

describe('lookUpCity', () => {
  const answer = (r: Record<string, unknown>): Fetch =>
    (async () => ({ json: async () => ({ results: [r] }) }) as Response) as unknown as Fetch
  const LONDON = { latitude: 51.5072, longitude: -0.1276, country_code: 'GB', name: 'London', timezone: 'Europe/London' }
  it('lookUpCity returns timezone', async () => {
    expect(await lookUpCity(answer(LONDON), 'London')).toMatchObject({ latitude: '51.51', longitude: '-0.13', tempUnit: 'celsius', timezone: 'Europe/London' })
  })
  it('drops an invalid timezone', async () => {
    const place = await lookUpCity(answer({ ...LONDON, timezone: 'Mars/Olympus' }), 'London')
    expect(place?.latitude).toBe('51.51')
    expect(place?.timezone).toBeUndefined()
    expect((await lookUpCity(answer({ ...LONDON, timezone: 42 }), 'London'))?.timezone).toBeUndefined()
  })
})

describe('validName', () => {
  it('accepts a plain name within the limit', () => {
    expect(validName('Jane', 80)).toBe(true)
    expect(validName('x'.repeat(40), 40)).toBe(true)
  })
  it('refuses empty, long, quoted, backslashed and control-character names', () => {
    expect(validName('   ', 80)).toBe(false)
    expect(validName('x'.repeat(41), 40)).toBe(false)
    expect(validName('Ja"ne', 80)).toBe(false)
    expect(validName('Ja\\ne', 80)).toBe(false)
    expect(validName('Ja\nne', 80)).toBe(false)
    expect(validName('Ja\u0000ne', 80)).toBe(false)
  })
})

describe('renderEnv', () => {
  it('fills platform credentials exactly as the terminal wizard did', () => {
    const a = answersFromWeb(PROFILE, { kind: 'later' }, null, '/p')
    const env = renderEnv(a, { botToken: '1:abc', chatId: '42' })
    expect(env).toMatch(/^TELEGRAM_BOT_TOKEN=1:abc$/m)
    expect(env).toMatch(/^ALLOWED_CHAT_ID=42$/m)
  })
  it('keeps a $ in a value literal', () => {
    const a = answersFromWeb(PROFILE, { kind: 'later' }, null, '/p')
    expect(renderEnv(a, { botToken: "1:a$&b$1c$'" })).toMatch(/^TELEGRAM_BOT_TOKEN=1:a\$&b\$1c\$'$/m)
  })
})

describe('setup edge', () => {
  it('exposes only the setup routes when asked for setup alone', () => {
    const c = buildCaddyfile('1-2-3-4.sslip.io', { teams: false, shortcuts: false, setup: true })
    expect(c).toContain('path /setup /setup/ /setup/api/*')
    expect(c).not.toContain('/api/teams')
    expect(c).not.toContain('/api/shortcut')
    expect(c).toContain('replace token REDACTED')
    expect(c).toContain('respond 404')
  })
  it('leaves setup out by default', () => {
    expect(buildCaddyfile('1-2-3-4.sslip.io')).not.toContain('/setup')
  })
  it('builds a unit that conflicts with the assistant and stays down after a clean exit', () => {
    const u = buildSetupUnit('/home/havn/havn')
    expect(u).toContain('ExecStart=/usr/bin/node /home/havn/havn/dist/scripts/setup-web.js --hosted')
    expect(u).toContain('Conflicts=havn.service')
    expect(u).toContain('Restart=on-failure')
    expect(u).toContain('User=havn')
    expect(u).toContain('NoNewPrivileges=true')
    expect(() => buildSetupUnit('/home/havn/havn; rm -rf /')).toThrow()
  })
  it('appends to a log enable-setup pre-creates as havn, so rotation can empty it', () => {
    const u = buildSetupUnit('/home/havn/havn')
    const logs = [...u.matchAll(/^Standard(?:Output|Error)=append:(\S+)$/gm)].map((m) => m[1])
    expect(logs).toHaveLength(2)
    for (const l of logs) expect(UNIT_LOGS.map((x) => `/home/havn/havn/${x}`)).toContain(l)
    // The assistant's own log too: havn.service appends to it after the handoff.
    expect(UNIT_LOGS).toContain('logs/service.log')
  })
  it('hands off through a root path unit watching the marker, not sudo', () => {
    expect(buildHandoffPath('/home/havn/havn')).toContain('PathExists=/home/havn/havn/store/setup-finished')
    const svc = buildHandoffService()
    expect(svc).toContain('ExecStart=/bin/systemctl disable --now havn-setup.service havn-setup-done.path')
    expect(svc).toContain('ExecStart=/bin/systemctl enable --now havn.service')
    expect(svc).not.toContain('User=')
  })
})
