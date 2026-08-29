/**
 * tests/secret-flow.test.ts
 *
 * The /secret chat command: clients on hosted boxes have no SSH, so this is
 * how an API key gets into the encrypted vault. The whole point of the flow
 * is that the key value never reaches the model — it is captured in code,
 * written to the vault, and the client's message is deleted from the chat.
 * These tests pin the state machine (prompt → capture → confirm), the TTL,
 * masking, and the three validation outcomes. Everything runs against a
 * throwaway vault dir and an injected validator.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretVault } from '../src/vault/store.js'
import { SecretFlow, maskSecret, type ValidationResult } from '../src/secrets/flow.js'

let dir: string
let vault: SecretVault
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secret-flow-'))
  vault = new SecretVault({ dir })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ok = async (): Promise<ValidationResult> => ({ status: 'ok' })

function makeFlow(opts: {
  validate?: (name: string, value: string) => Promise<ValidationResult>
  now?: () => number
  ttlMs?: number
  envFile?: Record<string, string>
  processEnv?: Record<string, string | undefined>
} = {}) {
  return new SecretFlow({
    vault: () => vault,
    validate: opts.validate ?? ok,
    now: opts.now,
    ttlMs: opts.ttlMs,
    // Empty by default: without this the flow would read the real .env of
    // whatever checkout the suite runs in.
    readEnvFile: () => opts.envFile ?? {},
    processEnv: () => opts.processEnv ?? {},
  })
}

const CHAT = '12345'

describe('maskSecret', () => {
  it('shows only the last 4 characters of a long value', () => {
    const masked = maskSecret('sk-ant-api03-abcdefgh-wxyz')
    expect(masked).toContain('wxyz')
    expect(masked).not.toContain('abcdefgh')
    expect(masked.length).toBeLessThan(12)
  })

  it('fully masks short values so nothing leaks', () => {
    expect(maskSecret('hunter2')).not.toContain('2')
  })
})

describe('SecretFlow.handleCommand', () => {
  it('shows usage for bare /secret', async () => {
    const { reply } = await makeFlow().handleCommand(CHAT, '/secret')
    expect(reply).toContain('/secret set')
    expect(reply).toContain('/secret list')
    expect(reply).toContain('/secret rm')
  })

  it('set with a name enters capture mode and prompts for the value', async () => {
    const flow = makeFlow()
    const { reply } = await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    expect(reply).toContain('OPENAI_API_KEY')
    expect(flow.hasPending(CHAT)).toBe(true)
  })

  it('normalizes the name to uppercase', async () => {
    const flow = makeFlow()
    const { reply } = await flow.handleCommand(CHAT, '/secret set openai_api_key')
    expect(reply).toContain('OPENAI_API_KEY')
  })

  it('rejects names that are not env-var shaped', async () => {
    const flow = makeFlow()
    const { reply } = await flow.handleCommand(CHAT, '/secret set not-a-name!')
    expect(reply.toLowerCase()).toContain('name')
    expect(flow.hasPending(CHAT)).toBe(false)
  })

  it('set with an inline value saves immediately and asks to delete the message', async () => {
    const flow = makeFlow()
    const res = await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY sk-test-12345678')
    expect(vault.get('OPENAI_API_KEY')).toBe('sk-test-12345678')
    expect(res.deleteUserMessage).toBe(true)
    expect(res.reply).not.toContain('sk-test-12345678')
    expect(flow.hasPending(CHAT)).toBe(false)
  })

  it('list shows vault names, never values', async () => {
    vault.set('OPENAI_API_KEY', 'sk-secret-value')
    const { reply } = await makeFlow().handleCommand(CHAT, '/secret list')
    expect(reply).toContain('OPENAI_API_KEY')
    expect(reply).not.toContain('sk-secret-value')
  })

  it('list shows keys that live in .env, not only the vault', async () => {
    const { reply } = await makeFlow({ envFile: { TELEGRAM_BOT_TOKEN: '77:tok-abcd' } }).handleCommand(
      CHAT,
      '/secret list'
    )
    expect(reply).toContain('TELEGRAM_BOT_TOKEN')
    expect(reply).toContain('.env')
    expect(reply).not.toContain('77:tok-abcd')
  })

  it('list with nothing configured anywhere says so', async () => {
    const { reply } = await makeFlow().handleCommand(CHAT, '/secret list')
    expect(reply.toLowerCase()).toContain('no api keys are configured')
  })

  it('rm removes a stored secret', async () => {
    vault.set('OPENAI_API_KEY', 'v')
    const { reply } = await makeFlow().handleCommand(CHAT, '/secret rm OPENAI_API_KEY')
    expect(vault.has('OPENAI_API_KEY')).toBe(false)
    expect(reply).toContain('OPENAI_API_KEY')
  })

  it('rm on a missing name reports not found', async () => {
    const { reply } = await makeFlow().handleCommand(CHAT, '/secret rm MISSING_KEY')
    expect(reply.toLowerCase()).toContain('not')
  })

  it('cancel clears a pending capture', async () => {
    const flow = makeFlow()
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    const { reply } = await flow.handleCommand(CHAT, '/secret cancel')
    expect(flow.hasPending(CHAT)).toBe(false)
    expect(reply.toLowerCase()).toContain('cancel')
  })
})

describe('SecretFlow.capture', () => {
  it('returns null when nothing is pending', async () => {
    expect(await makeFlow().capture(CHAT, 'just a normal message')).toBeNull()
  })

  it('captures the next message into the vault and confirms with a mask', async () => {
    const flow = makeFlow()
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    const res = await flow.capture(CHAT, '  sk-test-abcd1234  ')
    expect(res).not.toBeNull()
    expect(res!.saved).toBe(true)
    expect(res!.deleteUserMessage).toBe(true)
    expect(vault.get('OPENAI_API_KEY')).toBe('sk-test-abcd1234')
    expect(res!.reply).toContain('1234')
    expect(res!.reply).not.toContain('sk-test-abcd1234')
    expect(flow.hasPending(CHAT)).toBe(false)
  })

  it('capture state is per chat', async () => {
    const flow = makeFlow()
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    expect(await flow.capture('99999', 'sk-other-chat')).toBeNull()
    expect(vault.has('OPENAI_API_KEY')).toBe(false)
  })

  it('a provider-rejected key is not saved and capture stays pending for a retry', async () => {
    const flow = makeFlow({
      validate: async () => ({ status: 'invalid', detail: 'HTTP 401' }),
    })
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    const res = await flow.capture(CHAT, 'sk-wrong-key-9999')
    expect(res!.saved).toBe(false)
    expect(vault.has('OPENAI_API_KEY')).toBe(false)
    expect(res!.deleteUserMessage).toBe(true)
    expect(res!.reply.toLowerCase()).toContain('rejected')
    expect(flow.hasPending(CHAT)).toBe(true)
  })

  it('an unverifiable key is saved with a warning', async () => {
    const flow = makeFlow({
      validate: async () => ({ status: 'unverified', detail: 'network error' }),
    })
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    const res = await flow.capture(CHAT, 'sk-maybe-fine-8888')
    expect(res!.saved).toBe(true)
    expect(vault.get('OPENAI_API_KEY')).toBe('sk-maybe-fine-8888')
    expect(res!.reply.toLowerCase()).toContain('verify')
  })

  it('warns when the name is not one the engine reads', async () => {
    const flow = makeFlow()
    await flow.handleCommand(CHAT, '/secret set MY_CUSTOM_KEY')
    const res = await flow.capture(CHAT, 'custom-value-7777')
    expect(res!.saved).toBe(true)
    expect(res!.reply.toLowerCase()).toContain('engine')
  })

  it('an expired capture still deletes the message but saves nothing', async () => {
    let t = 1_000_000
    const flow = makeFlow({ now: () => t, ttlMs: 60_000 })
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    t += 61_000
    const res = await flow.capture(CHAT, 'sk-too-late-4321')
    expect(res!.saved).toBe(false)
    expect(res!.deleteUserMessage).toBe(true)
    expect(vault.has('OPENAI_API_KEY')).toBe(false)
    expect(res!.reply.toLowerCase()).toContain('expired')
    expect(flow.hasPending(CHAT)).toBe(false)
  })

  it('cancelPending clears state and reports whether anything was pending', async () => {
    const flow = makeFlow()
    expect(flow.cancelPending(CHAT)).toBe(false)
    await flow.handleCommand(CHAT, '/secret set OPENAI_API_KEY')
    expect(flow.cancelPending(CHAT)).toBe(true)
    expect(flow.hasPending(CHAT)).toBe(false)
  })
})
