/**
 * tests/ai-sdk-provider.test.ts
 *
 * Phase 3 (add providers) coverage for resolveModel() in
 * src/runtime/ai-sdk/provider.ts. The AI SDK runtime must:
 *   - resolve a LanguageModel for anthropic, openai, and google from
 *     AI_PROVIDER / AI_MODEL,
 *   - use the same .env-over-process.env precedence the claude runtime uses,
 *   - require an explicit AI_MODEL for non-anthropic providers (no guessed
 *     default model id that could rot),
 *   - pass AI_BASE_URL through on the openai case so OpenAI-compatible /
 *     self-hosted endpoints work without a separate provider package,
 *   - fail loudly with the provider-specific key name when the key is missing,
 *   - and list every available provider in the unknown-provider error.
 *
 * readEnvFile() is mocked (same seam as claude-runtime.test.ts) so the real
 * .env never leaks into the assertions. The provider factories are real, but
 * they construct offline (no network until an actual generate call), so
 * asserting `model` is truthy is safe and hits no API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadEnvFile } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn((): Record<string, string> => ({})),
}))

vi.mock('../src/env.js', () => ({ readEnvFile: mockReadEnvFile }))

import { resolveModel, buildModel } from '../src/runtime/ai-sdk/provider.js'
import { SecretVault } from '../src/vault/store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROVIDER_ENV_KEYS = [
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
]

function clearProviderEnv(): void {
  for (const k of PROVIDER_ENV_KEYS) delete process.env[k]
}

beforeEach(() => {
  mockReadEnvFile.mockReset()
  mockReadEnvFile.mockReturnValue({})
  clearProviderEnv()
})

afterEach(() => {
  clearProviderEnv()
})

describe('resolveModel() provider resolution', () => {
  it('resolves the anthropic provider with an explicit model', () => {
    mockReadEnvFile.mockReturnValue({
      AI_PROVIDER: 'anthropic',
      AI_MODEL: 'claude-opus-4-8',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    })
    const r = resolveModel()
    expect(r.provider).toBe('anthropic')
    expect(r.modelId).toBe('claude-opus-4-8')
    expect(r.model).toBeTruthy()
  })

  it('defaults the anthropic model when AI_MODEL is unset', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' })
    const r = resolveModel()
    expect(r.provider).toBe('anthropic')
    expect(r.modelId).toBe('claude-sonnet-5')
  })

  it('resolves the openai provider', () => {
    mockReadEnvFile.mockReturnValue({
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5',
      OPENAI_API_KEY: 'sk-openai-test',
    })
    const r = resolveModel()
    expect(r.provider).toBe('openai')
    expect(r.modelId).toBe('gpt-5')
    expect(r.model).toBeTruthy()
  })

  it('resolves the google provider', () => {
    mockReadEnvFile.mockReturnValue({
      AI_PROVIDER: 'google',
      AI_MODEL: 'gemini-2.5-pro',
      GOOGLE_API_KEY: 'goog-test',
    })
    const r = resolveModel()
    expect(r.provider).toBe('google')
    expect(r.modelId).toBe('gemini-2.5-pro')
    expect(r.model).toBeTruthy()
  })

  it('resolves openai with a custom AI_BASE_URL (OpenAI-compatible / self-hosted)', () => {
    mockReadEnvFile.mockReturnValue({
      AI_PROVIDER: 'openai',
      AI_MODEL: 'llama-3.3-70b',
      OPENAI_API_KEY: 'local-key',
      AI_BASE_URL: 'http://localhost:11434/v1',
    })
    const r = resolveModel()
    expect(r.provider).toBe('openai')
    expect(r.model).toBeTruthy()
  })
})

describe('resolveModel() precedence and env fallback', () => {
  it('prefers .env AI_PROVIDER over process.env', () => {
    mockReadEnvFile.mockReturnValue({
      AI_PROVIDER: 'google',
      AI_MODEL: 'gemini-2.5-pro',
      GOOGLE_API_KEY: 'g',
    })
    process.env.AI_PROVIDER = 'openai'
    expect(resolveModel().provider).toBe('google')
  })

  it('falls back to process.env when .env is empty', () => {
    mockReadEnvFile.mockReturnValue({})
    process.env.AI_PROVIDER = 'openai'
    process.env.AI_MODEL = 'gpt-5'
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    expect(resolveModel().provider).toBe('openai')
  })

  it('defaults to anthropic when no provider is set anywhere', () => {
    mockReadEnvFile.mockReturnValue({ ANTHROPIC_API_KEY: 'sk-ant-test' })
    expect(resolveModel().provider).toBe('anthropic')
  })
})

describe('resolveModel() error paths', () => {
  it('throws naming OPENAI_API_KEY when the openai key is missing', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-5' })
    expect(() => resolveModel()).toThrow(/OPENAI_API_KEY/)
  })

  it('throws naming GOOGLE_API_KEY when the google key is missing', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'google', AI_MODEL: 'gemini-2.5-pro' })
    expect(() => resolveModel()).toThrow(/GOOGLE_API_KEY/)
  })

  it('throws naming ANTHROPIC_API_KEY when the anthropic key is missing', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-4-8' })
    expect(() => resolveModel()).toThrow(/ANTHROPIC_API_KEY/)
  })

  it('requires an explicit AI_MODEL for non-anthropic providers', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-openai-test' })
    expect(() => resolveModel()).toThrow(/AI_MODEL/)
  })

  it('lists every available provider in the unknown-provider error', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'cohere', AI_MODEL: 'command-r' })
    expect(() => resolveModel()).toThrow(/Available: anthropic, openai, google/)
  })
})

describe('buildModel() explicit construction (shared by resolveModel + eval/probe scripts)', () => {
  it('builds an anthropic model from explicit args', () => {
    expect(buildModel('anthropic', 'claude-sonnet-5', { apiKey: 'k' })).toBeTruthy()
  })

  it('builds an openai model from explicit args', () => {
    expect(buildModel('openai', 'gpt-5', { apiKey: 'k' })).toBeTruthy()
  })

  it('builds a google model from explicit args', () => {
    expect(buildModel('google', 'gemini-2.5-pro', { apiKey: 'k' })).toBeTruthy()
  })

  it('passes baseURL through for openai without throwing', () => {
    expect(
      buildModel('openai', 'llama-3.3-70b', { apiKey: 'k', baseURL: 'http://localhost:11434/v1' })
    ).toBeTruthy()
  })

  it('throws on an unknown provider, listing the supported set', () => {
    expect(() => buildModel('cohere', 'command-r', { apiKey: 'k' })).toThrow(
      /Available: anthropic, openai, google/
    )
  })
})

describe('resolveModel() BYOK vault-backed key', () => {
  it('accepts a provider API key stored in the vault (absent from .env/process.env)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prov-vault-'))
    new SecretVault({ dir }).set('OPENAI_API_KEY', 'sk-from-vault')
    const prev = process.env.AGENT_VAULT_DIR
    process.env.AGENT_VAULT_DIR = dir
    // env provides provider + model but NO key; it must come from the vault
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-5' })
    try {
      const r = resolveModel()
      expect(r.provider).toBe('openai')
      expect(r.model).toBeTruthy()
    } finally {
      if (prev === undefined) delete process.env.AGENT_VAULT_DIR
      else process.env.AGENT_VAULT_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still throws when the key is in neither the vault, .env, nor process.env', () => {
    mockReadEnvFile.mockReturnValue({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-5' })
    expect(() => resolveModel()).toThrow(/OPENAI_API_KEY/)
  })
})
