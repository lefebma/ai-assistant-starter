/**
 * tests/secret-inventory.test.ts
 *
 * `/secret list` used to read the vault and nothing else, so a client whose
 * keys were written into .env at install time (i.e. every client) was told
 * "No secrets in the vault yet" while the assistant was happily using those
 * keys. The inventory answers the question the client actually asks — what is
 * configured, and where is it coming from — across all three sources the
 * resolver reads (vault -> .env -> process env), with values masked.
 */
import { describe, expect, it } from 'vitest'
import { buildSecretInventory, formatSecretInventory } from '../src/secrets/inventory.js'

const empty = { vault: {}, envFile: {}, processEnv: {} }

describe('buildSecretInventory', () => {
  it('reports a key set only in .env, not just the vault', () => {
    const inv = buildSecretInventory({ ...empty, envFile: { TELEGRAM_BOT_TOKEN: '123456:abcdefgh' } })
    const entry = inv.set.find((e) => e.name === 'TELEGRAM_BOT_TOKEN')
    expect(entry?.source).toBe('env-file')
    expect(entry?.masked).toContain('efgh')
    expect(entry?.masked).not.toContain('123456')
  })

  it('reads the process environment when neither vault nor .env has it', () => {
    const inv = buildSecretInventory({ ...empty, processEnv: { OPENAI_API_KEY: 'sk-live-wxyz' } })
    expect(inv.set.find((e) => e.name === 'OPENAI_API_KEY')?.source).toBe('process-env')
  })

  it('gives the vault precedence and records the shadowed source', () => {
    const inv = buildSecretInventory({
      vault: { OPENAI_API_KEY: 'sk-vault-1111' },
      envFile: { OPENAI_API_KEY: 'sk-envfile-2222' },
      processEnv: { OPENAI_API_KEY: 'sk-proc-3333' },
    })
    const entry = inv.set.find((e) => e.name === 'OPENAI_API_KEY')
    expect(entry?.source).toBe('vault')
    expect(entry?.masked).toContain('1111')
    expect(entry?.alsoIn).toEqual(['env-file', 'process-env'])
  })

  it('treats a blank or whitespace value as unset, matching getSecret', () => {
    const inv = buildSecretInventory({ vault: {}, envFile: { OPENAI_API_KEY: '   ' }, processEnv: {} })
    expect(inv.set.find((e) => e.name === 'OPENAI_API_KEY')).toBeUndefined()
    expect(inv.missing).toContain('OPENAI_API_KEY')
  })

  it('lists the engine keys that are set nowhere', () => {
    const inv = buildSecretInventory(empty)
    expect(inv.set).toHaveLength(0)
    expect(inv.missing).toContain('ANTHROPIC_API_KEY')
    expect(inv.missing).toContain('ELEVENLABS_API_KEY')
  })

  it('surfaces secret-looking .env keys the engine does not read itself', () => {
    const inv = buildSecretInventory({ ...empty, envFile: { PERPLEXITY_API_KEY: 'pplx-abcd1234' } })
    const entry = inv.set.find((e) => e.name === 'PERPLEXITY_API_KEY')
    expect(entry?.source).toBe('env-file')
    expect(entry?.known).toBe(false)
  })

  it('ignores plain .env config so the list stays a secret list', () => {
    const inv = buildSecretInventory({
      ...empty,
      envFile: { TIMEZONE: 'America/Toronto', ALLOWED_CHAT_ID: '12345', VAULT_KEY_BACKEND: 'keyring' },
    })
    expect(inv.set.map((e) => e.name)).toEqual([])
  })

  it('includes a vault name the engine does not read', () => {
    const inv = buildSecretInventory({ ...empty, vault: { CUSTOM_THING: 'value-9999' } })
    const entry = inv.set.find((e) => e.name === 'CUSTOM_THING')
    expect(entry?.source).toBe('vault')
    expect(entry?.known).toBe(false)
  })
})

describe('formatSecretInventory', () => {
  it('groups by source and never prints a full value', () => {
    const text = formatSecretInventory(
      buildSecretInventory({
        vault: { ANTHROPIC_API_KEY: 'sk-ant-vault-1111' },
        envFile: { TELEGRAM_BOT_TOKEN: '99:tele-2222', ANTHROPIC_API_KEY: 'sk-ant-old-3333' },
        processEnv: {},
      })
    )
    expect(text).toContain('ANTHROPIC_API_KEY')
    expect(text).toContain('TELEGRAM_BOT_TOKEN')
    expect(text).not.toContain('sk-ant-vault-1111')
    expect(text).not.toContain('99:tele-2222')
    expect(text.toLowerCase()).toContain('vault')
    expect(text).toContain('.env')
  })

  it('names the keys that are set nowhere so the client knows what to add', () => {
    const text = formatSecretInventory(buildSecretInventory(empty))
    expect(text.toLowerCase()).toContain('not set')
    expect(text).toContain('ELEVENLABS_API_KEY')
  })

  it('flags a .env value the vault is overriding', () => {
    const text = formatSecretInventory(
      buildSecretInventory({
        vault: { OPENAI_API_KEY: 'sk-new-1111' },
        envFile: { OPENAI_API_KEY: 'sk-old-2222' },
        processEnv: {},
      })
    )
    expect(text.toLowerCase()).toContain('overrid')
    expect(text).toContain('OPENAI_API_KEY')
  })
})
