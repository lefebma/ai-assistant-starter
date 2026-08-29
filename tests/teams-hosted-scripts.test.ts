import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyfile, isValidHostname, sslipHostname } from '../src/deploy/teams-edge.js'
import { parseRegisterArgs, registrationPlan, pickExistingAppId } from '../src/deploy/teams-register.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENABLE = join(ROOT, 'scripts', 'hosted', 'enable-teams.ts')
const REGISTER = join(ROOT, 'scripts', 'teams-register.ts')

describe('teams edge (Caddy) config', () => {
  it('proxies only the webhook path and answers 404 elsewhere', () => {
    const c = buildCaddyfile('5-161-197-79.sslip.io')
    expect(c).toContain('5-161-197-79.sslip.io {')
    expect(c).toContain('handle /api/teams/* {')
    expect(c).toContain('reverse_proxy 127.0.0.1:3030')
    expect(c).toContain('respond 404')
    expect(c).not.toContain('cockpit')
  })

  it('accepts real hostnames and rejects junk before it can reach a config file', () => {
    expect(isValidHostname('5-161-197-79.sslip.io')).toBe(true)
    expect(isValidHostname('havn.example.com')).toBe(true)
    for (const bad of ['bad_host', 'no-dots', 'a..b', 'x;rm -rf /', 'Upper.Case.Com', '-lead.example.com', '']) {
      expect(isValidHostname(bad), bad).toBe(false)
    }
    expect(() => buildCaddyfile('x;rm -rf /')).toThrow(/valid hostname/)
  })

  it('derives the sslip.io name from an IPv4 address', () => {
    expect(sslipHostname('5.161.197.79')).toBe('5-161-197-79.sslip.io')
    expect(() => sslipHostname('not-an-ip')).toThrow(/IPv4/)
  })

  it('generates voice routes when voice is enabled', () => {
    const c = buildCaddyfile('5-161-197-79.sslip.io', { voice: true })
    expect(c).toContain('handle /api/teams/* {')
    expect(c).toContain('path /voice /voice/')
    expect(c).toContain('/api/transcribe')
    expect(c).toContain('respond 404')
  })

  it('keeps every credential out of the generated config', () => {
    // The edge used to embed HTTP_BEARER_TOKEN in a query matcher, which put a
    // copy of the box-wide secret in /etc/caddy/Caddyfile and made rotating it
    // a redeploy. The app validates per-chat link tokens instead.
    const c = buildCaddyfile('5-161-197-79.sslip.io', { voice: true })
    expect(c).not.toMatch(/query token=/)
    // No token is ever assigned a value here; the word only survives in a comment.
    expect(c).not.toMatch(/token=\S/)
  })

  it('logs access with the credential-bearing fields redacted at write time', () => {
    // A voice link carries its token in the query string and the page replays
    // it as a bearer header, so an unfiltered access log would put working
    // credentials on disk twice over. Client addresses are masked to the
    // network: enough to tell a datacentre crawler from a person, not enough
    // to follow one around.
    const c = buildCaddyfile('5-161-197-79.sslip.io', { voice: true })
    expect(c).toContain('log {')
    expect(c).toContain('replace token REDACTED')
    expect(c).toContain('request>headers>Authorization delete')
    expect(c).toContain('request>headers>Cookie delete')
    expect(c).toContain('ip_mask')
    // Rotation, so a long-lived box does not fill its disk with request lines.
    expect(c).toContain('roll_keep')
  })

  it('logs even without the voice UI, so a Teams-only box still has request history', () => {
    expect(buildCaddyfile('5-161-197-79.sslip.io')).toContain('/var/log/caddy/access.log')
  })

  it('omits Teams routes when teams is false', () => {
    const c = buildCaddyfile('5-161-197-79.sslip.io', { teams: false, voice: true })
    expect(c).not.toContain('handle /api/teams/*')
    expect(c).toContain('path /voice /voice/')
  })

  it('generates teams-only config when no options are passed (backward compat)', () => {
    const c = buildCaddyfile('5-161-197-79.sslip.io')
    expect(c).toContain('handle /api/teams/* {')
    expect(c).not.toContain('/voice')
    expect(c).toContain('respond 404')
  })
})

describe('enable-teams script', () => {
  it('exists, opens only 80 and 443, runs every command without a shell, and prints the endpoint', () => {
    expect(existsSync(ENABLE)).toBe(true)
    const t = readFileSync(ENABLE, 'utf-8')
    expect(t).toContain("['allow', '80/tcp']")
    expect(t).toContain("['allow', '443/tcp']")
    expect(t).not.toMatch(/allow.*3030/)
    expect(t).not.toMatch(/\bexecSync\(|\bexec\(|shell:\s*true/)
    expect(t).toContain('/api/teams/messages')
  })

  it('supports --voice and records the hostname instead of copying a secret', () => {
    const t = readFileSync(ENABLE, 'utf-8')
    expect(t).toContain("'--voice'")
    expect(t).toContain('PUBLIC_HOSTNAME')
    // Reading the bearer token out of .env to paste into a URL is the thing
    // this replaced; if it comes back, so does the operator's standing key.
    expect(t).not.toContain('HTTP_BEARER_TOKEN')
  })
})

describe('teams-register', () => {
  it('parses the positional args and flags with the documented defaults', () => {
    expect(parseRegisterArgs(['test', '5-161-197-79.sslip.io'])).toEqual({
      name: 'test',
      hostname: '5-161-197-79.sslip.io',
      tenant: undefined,
      resourceGroup: 'havn-bots',
      location: 'global',
      rotateSecret: false,
    })
    expect(
      parseRegisterArgs(['acme', 'bot.acme.com', '--tenant', 't-1', '--resource-group', 'rg', '--location', 'westeurope', '--rotate-secret'])
    ).toEqual({ name: 'acme', hostname: 'bot.acme.com', tenant: 't-1', resourceGroup: 'rg', location: 'westeurope', rotateSecret: true })
  })

  it('refuses missing positionals, a bad hostname, a bad name, and unknown flags', () => {
    expect(() => parseRegisterArgs(['onlyname'])).toThrow(/Usage/)
    expect(() => parseRegisterArgs(['test', 'not a host'])).toThrow(/hostname/)
    expect(() => parseRegisterArgs(['Bad Name!', 'bot.acme.com'])).toThrow(/name/)
    expect(() => parseRegisterArgs(['test', 'bot.acme.com', '--nope'])).toThrow(/Unknown/)
    expect(() => parseRegisterArgs(['test', 'bot.acme.com', '--tenant'])).toThrow(/value/)
  })

  it('always plans a single-tenant registration (Azure refuses new multi-tenant bots)', () => {
    const plan = registrationPlan(parseRegisterArgs(['test', '5-161-197-79.sslip.io']))
    expect(plan).toEqual({
      displayName: 'Havn - test',
      botName: 'havn-test',
      endpoint: 'https://5-161-197-79.sslip.io/api/teams/messages',
      audience: 'AzureADMyOrg',
      appType: 'SingleTenant',
      groupLocation: 'eastus',
    })
    const explicit = registrationPlan(parseRegisterArgs(['acme', 'bot.acme.com', '--tenant', 't-1', '--location', 'westeurope']))
    expect(explicit.audience).toBe('AzureADMyOrg')
    expect(explicit.appType).toBe('SingleTenant')
    expect(explicit.groupLocation).toBe('westeurope')
  })

  it('script resolves the tenant from the az session when --tenant is absent and always emits TEAMS_TENANT_ID', () => {
    const t = readFileSync(REGISTER, 'utf-8')
    expect(t).toMatch(/'account', 'show', '--query', 'tenantId'/)
    expect(t).toContain("'--tenant-id', tenant")
    expect(t).toContain('`TEAMS_TENANT_ID=${tenant}`')
    expect(t).not.toMatch(/MultiTenant|AzureADMultipleOrgs/)
  })

  it('script ensures a service principal exists for the app (single-tenant client credentials need one)', () => {
    const t = readFileSync(REGISTER, 'utf-8')
    expect(t).toContain("['ad', 'sp', 'show', '--id', appId]")
    expect(t).toContain("['ad', 'sp', 'create', '--id', appId]")
  })

  it('reuses a single existing registration, creates when none, and refuses to guess between duplicates', () => {
    expect(pickExistingAppId('', 'Havn - test')).toBeNull()
    expect(pickExistingAppId('\n', 'Havn - test')).toBeNull()
    expect(pickExistingAppId('11111111-2222-3333-4444-555555555555\n', 'Havn - test')).toBe('11111111-2222-3333-4444-555555555555')
    expect(() => pickExistingAppId('aaa\nbbb\n', 'Havn - test')).toThrow(/2 app registrations are named "Havn - test" \(aaa, bbb\)/)
  })

  it('script drives az with argument arrays only and never puts the secret on a command line', () => {
    expect(existsSync(REGISTER)).toBe(true)
    const t = readFileSync(REGISTER, 'utf-8')
    expect(t).toContain("'ad', 'app', 'create'")
    expect(t).toContain("'bot', 'create'")
    expect(t).toContain("'bot', 'msteams', 'create'")
    expect(t).toContain("'bot', 'msteams', 'show'")
    expect(t).toContain("'credential', 'reset'")
    expect(t).toContain("'[].appId'")
    expect(t).not.toContain("'[0].appId'")
    expect(t).not.toMatch(/\bexecSync\(|\bexec\(|shell:\s*true/)
    expect(t).not.toMatch(/--password|'--secret'/)
  })
})
