import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const envState: { env: Record<string, string> } = { env: {} }
vi.mock('../src/env.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, readEnvFile: () => envState.env }
})

import { detectPlatform, createAdapter } from '../src/platform/index.js'
import { defaultVault } from '../src/vault/index.js'

// The web setup stores the bot token only in the vault and leaves
// TELEGRAM_BOT_TOKEN= empty in .env. The service must still start.
describe('platform adapter reads tokens through the vault', () => {
  let dir: string
  const saved = process.env.AGENT_VAULT_DIR
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-'))
    process.env.AGENT_VAULT_DIR = dir
  })
  afterEach(() => {
    envState.env = {}
    if (saved === undefined) delete process.env.AGENT_VAULT_DIR
    else process.env.AGENT_VAULT_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts Telegram with a vault-only token and an empty .env entry', async () => {
    envState.env = { TELEGRAM_BOT_TOKEN: '', ALLOWED_CHAT_ID: '1' }
    defaultVault().set('TELEGRAM_BOT_TOKEN', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi')
    expect(detectPlatform()).toBe('telegram')
    const adapter = await createAdapter()
    expect(adapter.name).toBe('telegram')
  })

  it('still says what is missing when neither has it', async () => {
    envState.env = { TELEGRAM_BOT_TOKEN: '' }
    await expect(createAdapter()).rejects.toThrow(/TELEGRAM_BOT_TOKEN not set/)
  })
})
