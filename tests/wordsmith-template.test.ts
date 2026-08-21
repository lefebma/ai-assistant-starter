/**
 * tests/wordsmith-template.test.ts
 *
 * The wordsmith skill template is always installed (no opt-in, no separate
 * API key), so its provider resolution has to work for every install shape:
 * whatever AI_PROVIDER the runtime uses, any other provider whose key is
 * present, and a clear error when no key exists at all. These tests import
 * the template's pure helpers directly; main() only runs when the script is
 * invoked as a CLI.
 *
 * The import is a native dynamic import via a file:// URL (with @vite-ignore)
 * instead of a static specifier: vite's transform of a static .mjs import
 * from outside the test root breaks on Windows runners with a bogus
 * SyntaxError, while the runtime import behaves identically on all three
 * platforms.
 */
import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
  /* @vite-ignore */
  pathToFileURL(join(__dirname, '..', 'templates', 'skills', 'wordsmith', 'wordsmith.mjs')).href
)
const { parseDotEnv, resolveTarget, buildRequest, extractText } = mod

describe('parseDotEnv', () => {
  it('parses KEY=value lines, strips quotes, ignores junk', () => {
    const env = parseDotEnv('A=1\n# comment\nB="two words"\nnot a line\nC=\n')
    expect(env).toEqual({ A: '1', B: 'two words', C: '' })
  })
})

describe('resolveTarget provider resolution', () => {
  it('uses AI_PROVIDER when its key is present', () => {
    const t = resolveTarget({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }, 'quality')
    expect(t.provider).toBe('openai')
    expect(t.model).toBe('gpt-5.4')
  })

  it('falls past AI_PROVIDER when its key is missing, to the first available key', () => {
    const t = resolveTarget({ AI_PROVIDER: 'openai', GOOGLE_API_KEY: 'g' }, 'fast')
    expect(t.provider).toBe('google')
    expect(t.model).toBe('gemini-2.5-flash')
  })

  it('prefers WORDSMITH_PROVIDER over everything', () => {
    const t = resolveTarget(
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', WORDSMITH_PROVIDER: 'anthropic' },
      'quality'
    )
    expect(t.provider).toBe('anthropic')
    expect(t.model).toBe('claude-sonnet-5')
  })

  it('honors WORDSMITH_MODEL over tier defaults', () => {
    const t = resolveTarget(
      { ANTHROPIC_API_KEY: 'a', WORDSMITH_MODEL: 'claude-opus-5' },
      'quality'
    )
    expect(t.model).toBe('claude-opus-5')
  })

  it('passes an explicit model id through untouched', () => {
    const t = resolveTarget({ GOOGLE_API_KEY: 'g' }, 'gemini-2.5-flash-lite')
    expect(t.model).toBe('gemini-2.5-flash-lite')
  })

  it('azure reuses AI_MODEL as the deployment when no explicit model is given', () => {
    const t = resolveTarget(
      { AZURE_API_KEY: 'z', AZURE_RESOURCE_NAME: 'contoso', AI_MODEL: 'gpt-5-4-mini' },
      'quality'
    )
    expect(t.provider).toBe('azure')
    expect(t.model).toBe('gpt-5-4-mini')
    expect(t.resourceName).toBe('contoso')
  })

  it('azure without any deployment name throws an actionable error', () => {
    expect(() =>
      resolveTarget({ AZURE_API_KEY: 'z', AZURE_RESOURCE_NAME: 'contoso' }, 'quality')
    ).toThrow(/deployment name/)
  })

  it('azure without resource name or base URL throws naming AZURE_RESOURCE_NAME', () => {
    expect(() =>
      resolveTarget({ AZURE_API_KEY: 'z', AI_MODEL: 'dep' }, 'quality')
    ).toThrow(/AZURE_RESOURCE_NAME/)
  })

  it('throws listing every key env when nothing is configured', () => {
    expect(() => resolveTarget({}, 'quality')).toThrow(
      /ANTHROPIC_API_KEY.*OPENAI_API_KEY.*GOOGLE_API_KEY.*AZURE_API_KEY/
    )
  })

  it('rejects an unknown WORDSMITH_PROVIDER', () => {
    expect(() => resolveTarget({ WORDSMITH_PROVIDER: 'cohere' }, 'quality')).toThrow(/cohere/)
  })
})

describe('buildRequest per provider', () => {
  const voice = 'be direct'
  const text = 'Task:\nwrite'

  it('anthropic: messages API with system field and temperature', () => {
    const r = buildRequest({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' }, voice, text)
    expect(r.url).toContain('api.anthropic.com/v1/messages')
    expect(r.headers['x-api-key']).toBe('k')
    expect(r.body.system).toBe(voice)
    expect(r.body.temperature).toBe(0.7)
    expect(r.body.messages[0]).toEqual({ role: 'user', content: text })
  })

  it('openai: chat completions, system message, NO temperature (gpt-5 family rejects it)', () => {
    const r = buildRequest({ provider: 'openai', model: 'gpt-5.4', apiKey: 'k' }, voice, text)
    expect(r.url).toContain('api.openai.com/v1/chat/completions')
    expect(r.headers.Authorization).toBe('Bearer k')
    expect(r.body.temperature).toBeUndefined()
    expect(r.body.messages[0]).toEqual({ role: 'system', content: voice })
  })

  it('google: generateContent with system_instruction', () => {
    const r = buildRequest({ provider: 'google', model: 'gemini-2.5-pro', apiKey: 'k' }, voice, text)
    expect(r.url).toContain('models/gemini-2.5-pro:generateContent')
    expect(r.body.system_instruction.parts[0].text).toBe(voice)
  })

  it('google: omits system_instruction when voice is empty', () => {
    const r = buildRequest({ provider: 'google', model: 'gemini-2.5-pro', apiKey: 'k' }, '', text)
    expect(r.body.system_instruction).toBeUndefined()
  })

  it('azure: deployment path on the resource-name URL with api-key header', () => {
    const r = buildRequest(
      { provider: 'azure', model: 'dep', apiKey: 'k', resourceName: 'contoso', baseURL: '', apiVersion: '2024-10-21' },
      voice,
      text
    )
    expect(r.url).toBe('https://contoso.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21')
    expect(r.headers['api-key']).toBe('k')
    expect(r.body.temperature).toBeUndefined()
  })

  it('azure: an explicit baseURL replaces the resource-name URL', () => {
    const r = buildRequest(
      { provider: 'azure', model: 'dep', apiKey: 'k', resourceName: '', baseURL: 'https://gov.example.us', apiVersion: 'v' },
      '',
      text
    )
    expect(r.url).toBe('https://gov.example.us/openai/deployments/dep/chat/completions?api-version=v')
  })
})

describe('extractText per provider', () => {
  it('google candidates shape', () => {
    expect(
      extractText('google', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] })
    ).toBe('ab')
  })

  it('anthropic content-blocks shape', () => {
    expect(extractText('anthropic', { content: [{ type: 'text', text: 'hi' }] })).toBe('hi')
  })

  it('openai/azure choices shape', () => {
    expect(extractText('openai', { choices: [{ message: { content: 'x' } }] })).toBe('x')
    expect(extractText('azure', { choices: [{ message: { content: 'y' } }] })).toBe('y')
  })
})
