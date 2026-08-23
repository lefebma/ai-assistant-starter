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

  it('plans a multi-tenant registration by default and single-tenant with --tenant', () => {
    const multi = registrationPlan(parseRegisterArgs(['test', '5-161-197-79.sslip.io']))
    expect(multi).toEqual({
      displayName: 'Havn - test',
      botName: 'havn-test',
      endpoint: 'https://5-161-197-79.sslip.io/api/teams/messages',
      audience: 'AzureADMultipleOrgs',
      appType: 'MultiTenant',
      groupLocation: 'eastus',
    })
    const single = registrationPlan(parseRegisterArgs(['acme', 'bot.acme.com', '--tenant', 't-1', '--location', 'westeurope']))
    expect(single.audience).toBe('AzureADMyOrg')
    expect(single.appType).toBe('SingleTenant')
    expect(single.groupLocation).toBe('westeurope')
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
