import { describe, it, expect } from 'vitest'
import { sep } from 'node:path'
import { checkCredentials } from '../src/setup/credentials.js'
import { parseAuthStatus, checkClaudeAuth } from '../src/infra/claude-auth.js'
import { bundledClaudeCandidates, resolveBundledClaude, sdkPlatformPackages } from '../src/infra/claude-bin.js'

const noEnv = () => undefined

describe('checkCredentials', () => {
  it('passes on the claude runtime when the machine is signed in', () => {
    const r = checkCredentials({ runtime: 'claude', env: noEnv, signedIn: true })
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/signed in/i)
  })

  it('passes on the claude runtime with only an API key (Claude Code honours it as auth)', () => {
    const r = checkCredentials({ runtime: 'claude', env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-x' : undefined), signedIn: false })
    expect(r.ok).toBe(true)
  })

  it('says how it authenticated rather than assuming an interactive sign-in', () => {
    // Claude Code reports loggedIn:true for an API key too. Telling someone
    // they are "signed in on this machine" sends them hunting for a sign-in
    // they never made.
    const r = checkCredentials({ runtime: 'claude', env: noEnv, signedIn: true, signInDetail: 'using an API key' })
    expect(r.detail).toBe('using an API key')
  })

  it('FAILS the case that used to self-test green: no sign-in, no key', () => {
    const r = checkCredentials({ runtime: 'claude', env: noEnv, signedIn: false })
    expect(r.ok).toBe(false)
    expect(r.remedy).toBeTruthy()
    // The remedy has to name both ways out, in words a non-technical owner can act on.
    expect(r.remedy).toMatch(/Pro or Max/)
    expect(r.remedy).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('treats whitespace-only keys as missing', () => {
    const r = checkCredentials({ runtime: 'claude', env: () => '   ', signedIn: false })
    expect(r.ok).toBe(false)
  })

  it('checks the provider-specific key on the ai-sdk runtime', () => {
    const withKey = (name: string) => (n: string) => (n === name ? 'k' : undefined)
    expect(checkCredentials({ runtime: 'ai-sdk', provider: 'openai', env: withKey('OPENAI_API_KEY'), signedIn: false }).ok).toBe(true)
    expect(checkCredentials({ runtime: 'ai-sdk', provider: 'google', env: withKey('GOOGLE_API_KEY'), signedIn: false }).ok).toBe(true)
    // A Claude sign-in does not authenticate a direct OpenAI call.
    expect(checkCredentials({ runtime: 'ai-sdk', provider: 'openai', env: noEnv, signedIn: true }).ok).toBe(false)
  })

  it('defaults the ai-sdk provider to anthropic, matching the runtime', () => {
    const r = checkCredentials({ runtime: 'ai-sdk', env: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-x' : undefined), signedIn: false })
    expect(r.ok).toBe(true)
  })

  it('names an unknown runtime or provider instead of passing silently', () => {
    expect(checkCredentials({ runtime: 'gpt-please', env: noEnv, signedIn: true }).ok).toBe(false)
    const p = checkCredentials({ runtime: 'ai-sdk', provider: 'cohere', env: () => 'k', signedIn: false })
    expect(p.ok).toBe(false)
    expect(p.detail).toMatch(/cohere/)
  })
})

describe('parseAuthStatus', () => {
  it('reads a signed-in payload and summarises the plan', () => {
    const r = parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"a@b.com"}')
    expect(r.loggedIn).toBe(true)
    expect(r.detail).toContain('Claude account')
    expect(r.detail).toContain('max')
    expect(r.detail).toContain('a@b.com')
  })

  it('distinguishes an API key from an interactive sign-in', () => {
    const r = parseAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}')
    expect(r.loggedIn).toBe(true)
    expect(r.detail).toBe('using an API key')
  })

  it('reads a logged-out payload', () => {
    expect(parseAuthStatus('{"loggedIn":false}').loggedIn).toBe(false)
  })

  it('fails closed on unparseable output rather than assuming success', () => {
    // A false "signed in" sends someone away from an install that cannot answer.
    expect(parseAuthStatus('command not found').loggedIn).toBe(false)
    expect(parseAuthStatus('').loggedIn).toBe(false)
    expect(parseAuthStatus('null').loggedIn).toBe(false)
    expect(parseAuthStatus('"yes"').loggedIn).toBe(false)
  })

  it('does not accept a truthy non-true loggedIn', () => {
    expect(parseAuthStatus('{"loggedIn":"true"}').loggedIn).toBe(false)
    expect(parseAuthStatus('{"loggedIn":1}').loggedIn).toBe(false)
  })
})

describe('checkClaudeAuth', () => {
  it('reports not-signed-in when the engine is missing, without throwing', () => {
    const r = checkClaudeAuth(null, () => {
      throw new Error('should not run')
    })
    expect(r.loggedIn).toBe(false)
    expect(r.detail).toMatch(/not found/i)
  })

  it('reports not-signed-in when the binary cannot be run', () => {
    expect(checkClaudeAuth('/nope/claude', () => null).loggedIn).toBe(false)
  })

  it('asks the binary the offline question', () => {
    const calls: string[][] = []
    const r = checkClaudeAuth('/i/claude', (_bin, args) => {
      calls.push(args)
      return '{"loggedIn":true,"authMethod":"claude.ai"}'
    })
    expect(calls).toEqual([['auth', 'status', '--json']])
    expect(r.loggedIn).toBe(true)
  })
})

describe('resolveBundledClaude', () => {
  it('looks inside the install, not on PATH', () => {
    // Separators are the host's: join() emits '\' on Windows, which is correct
    // for a Windows install and is what this assertion used to fail on.
    // Normalise so the check is about the layout, not the platform.
    const norm = (p: string) => p.split(sep).join('/')
    const paths = bundledClaudeCandidates('/opt/app', 'darwin', 'arm64')
    expect(norm(paths[0])).toBe('/opt/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
  })

  it('covers the musl linux packages too', () => {
    expect(sdkPlatformPackages('linux', 'x64')).toEqual([
      'claude-agent-sdk-linux-x64',
      'claude-agent-sdk-linux-x64-musl',
    ])
  })

  it('tries both binary names on Windows', () => {
    const paths = bundledClaudeCandidates('C:\\app', 'win32', 'x64')
    expect(paths.some((p) => p.endsWith('claude.exe'))).toBe(true)
    expect(paths.some((p) => p.endsWith('claude') && !p.endsWith('.exe'))).toBe(true)
  })

  it('returns null when the platform package is absent', () => {
    expect(resolveBundledClaude({}, '/opt/app', 'darwin', 'arm64', () => false)).toBeNull()
  })

  it('honours a CLAUDE_BIN override without touching the filesystem', () => {
    const r = resolveBundledClaude({ CLAUDE_BIN: '/custom/claude' }, '/opt/app', 'darwin', 'arm64', () => {
      throw new Error('should not stat')
    })
    expect(r).toBe('/custom/claude')
  })

  it('finds the real binary in this repo (the path customers actually get)', () => {
    // Guards against the SDK renaming its platform packages under us: this is
    // the resolution the shipped app depends on, so it is worth pinning to a
    // real filesystem rather than only to a fake.
    expect(resolveBundledClaude({}, process.cwd())).not.toBeNull()
  })
})
