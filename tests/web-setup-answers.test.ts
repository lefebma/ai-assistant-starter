import { describe, it, expect } from 'vitest'
import { answersFromWeb, InputError, parseEngine, parseProfile } from '../src/setup/web/answers.js'
import { PERSONALITY_PRESETS } from '../src/setup/wizard.js'
import { renderEnv } from '../src/setup/finalize.js'
import { buildCaddyfile } from '../src/deploy/teams-edge.js'
import { buildHandoffPath, buildHandoffService, buildSetupUnit } from '../src/deploy/setup-edge.js'

const RAW = { ownerName: '  Leif ', assistantName: 'Avery', timezone: 'America/Toronto', city: 'Toronto', vibe: 0, ownerBio: '' }

describe('parseProfile', () => {
  it('trims and keeps a valid profile', () => {
    expect(parseProfile(RAW)).toEqual({ ownerName: 'Leif', assistantName: 'Avery', timezone: 'America/Toronto', city: 'Toronto', vibe: 0, ownerBio: '' })
  })
  it('requires a name and a real timezone', () => {
    expect(() => parseProfile({ ...RAW, ownerName: '' })).toThrow(InputError)
    expect(() => parseProfile({ ...RAW, timezone: 'Mars/Olympus' })).toThrow(/not a timezone/)
    expect(() => parseProfile({ ...RAW, timezone: 'UTC; rm -rf /' })).toThrow(InputError)
  })
  it('refuses control characters that would break .env or markdown', () => {
    expect(() => parseProfile({ ...RAW, assistantName: 'Av\u0000ery' })).toThrow(InputError)
  })
  it('refuses quotes and backslashes, which would break the JSON skill manifests', () => {
    expect(() => parseProfile({ ...RAW, ownerName: 'Marc "Mo" L' })).toThrow(/quotation marks/)
    expect(() => parseProfile({ ...RAW, city: 'C:\\x' })).toThrow(/quotation marks/)
  })
  it('falls back to the friendly preset on a bad vibe', () => {
    expect(parseProfile({ ...RAW, vibe: 99 }).vibe).toBe(1)
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

describe('answersFromWeb', () => {
  it('maps to the answers a skip-everything wizard run gives, with no secrets', () => {
    const a = answersFromWeb(parseProfile(RAW), { kind: 'api-key', provider: 'openai', model: 'gpt-5' }, { latitude: '43.70', longitude: '-79.42', tempUnit: 'celsius', label: 'Toronto' }, '/p')
    expect(a).toMatchObject({
      platform: 'Telegram',
      engine: 'api-key',
      aiProvider: 'openai',
      personalityVibe: PERSONALITY_PRESETS[0],
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
  it("uses the wizard's default coordinates when the city lookup fails", () => {
    const a = answersFromWeb(parseProfile(RAW), { kind: 'later' }, null, '/p')
    expect([a.latitude, a.longitude]).toEqual(['40.71', '-74.01'])
  })
})

describe('renderEnv', () => {
  it('fills platform credentials exactly as the terminal wizard did', () => {
    const a = answersFromWeb(parseProfile(RAW), { kind: 'later' }, null, '/p')
    const env = renderEnv(a, { botToken: '1:abc', chatId: '42' })
    expect(env).toMatch(/^TELEGRAM_BOT_TOKEN=1:abc$/m)
    expect(env).toMatch(/^ALLOWED_CHAT_ID=42$/m)
  })
  it('keeps a $ in a value literal', () => {
    const a = answersFromWeb(parseProfile(RAW), { kind: 'later' }, null, '/p')
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
  it('hands off through a root path unit watching the marker, not sudo', () => {
    expect(buildHandoffPath('/home/havn/havn')).toContain('PathExists=/home/havn/havn/store/setup-finished')
    const svc = buildHandoffService()
    expect(svc).toContain('ExecStart=/bin/systemctl disable --now havn-setup.service havn-setup-done.path')
    expect(svc).toContain('ExecStart=/bin/systemctl enable --now havn.service')
    expect(svc).not.toContain('User=')
  })
})
