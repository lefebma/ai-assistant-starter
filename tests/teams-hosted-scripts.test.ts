import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCaddyfile, isValidHostname, sslipHostname } from '../src/deploy/teams-edge.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENABLE = join(ROOT, 'scripts', 'hosted', 'enable-teams.ts')

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
