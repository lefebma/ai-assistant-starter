import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/managed-ai-cli.js'
import { isManagedAi, writeAiLimit, readAiLimit } from '../src/ai-limit.js'

const KEY = 'sk-ant-api03-SECRETVALUE1234567890'

function setup(stdinValue = KEY + '\n', envExists = false) {
  const storeDir = mkdtempSync(join(tmpdir(), 'managed-ai-'))
  const vaultData = new Map<string, string>()
  let stdinCalls = 0
  const deps = {
    stdin: async () => {
      stdinCalls++
      return stdinValue
    },
    vault: {
      set: (n: string, v: string) => void vaultData.set(n, v),
      has: (n: string) => vaultData.has(n),
    },
    storeDir,
    envExists,
  }
  return { deps, storeDir, vaultData, calls: () => stdinCalls }
}

describe('managed-ai CLI', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('set stores the key in the vault, writes the marker, and never echoes the key', async () => {
    const out = await main(['set'], t.deps)
    expect(out).toBe('Managed AI key saved.')
    expect(t.vaultData.get('ANTHROPIC_API_KEY')).toBe(KEY)
    expect(isManagedAi(t.storeDir)).toBe(true)
    const marker = readFileSync(join(t.storeDir, 'managed-ai.json'), 'utf8')
    expect(marker).not.toContain('sk-ant')
    expect(Date.parse(JSON.parse(marker).since)).not.toBeNaN()
    expect(readdirSync(t.storeDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(out).not.toContain('sk-ant')
  })

  it('set adds the restart line when .env exists', async () => {
    const s = setup(KEY, true)
    const out = await main(['set'], s.deps)
    expect(out).toBe('Managed AI key saved.\nRestart the service to use it: sudo systemctl restart havn')
  })

  it('set clears any limit marker', async () => {
    writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString() }, t.storeDir)
    await main(['set'], t.deps)
    expect(readAiLimit(t.storeDir)).toBeNull()
  })

  it('set rejects a value that is not an Anthropic key, without echoing it', async () => {
    const s = setup('hunter2-not-a-key\n')
    await expect(main(['set'], s.deps)).rejects.toThrow("That doesn't look like an Anthropic API key.")
    await main(['set'], s.deps).catch((e: Error) => expect(e.message).not.toContain('hunter2'))
    expect(s.vaultData.size).toBe(0)
    expect(isManagedAi(s.storeDir)).toBe(false)
  })

  it('set refuses an empty stdin', async () => {
    const s = setup('  \n')
    await expect(main(['set'], s.deps)).rejects.toThrow('No key received on stdin.')
    expect(s.vaultData.size).toBe(0)
  })

  it('set refuses a key in argv before reading stdin', async () => {
    await expect(main(['set', KEY], t.deps)).rejects.toThrow('Pass the key on stdin, not on the command line.')
    await main(['set', KEY], t.deps).catch((e: Error) => expect(e.message).not.toContain(KEY))
    expect(t.calls()).toBe(0)
    expect(t.vaultData.size).toBe(0)
    expect(isManagedAi(t.storeDir)).toBe(false)
  })

  it('status reports each state and never prints the key', async () => {
    expect(await main(['status'], t.deps)).toBe('Managed: no. Key: missing. Limit: none.')
    await main(['set'], t.deps)
    expect(await main(['status'], t.deps)).toBe('Managed: yes. Key: stored. Limit: none.')
    writeAiLimit({ kind: 'billing', since: '2026-10-23T10:00:00.000Z' }, t.storeDir)
    const out = await main(['status'], t.deps)
    expect(out).toBe('Managed: yes. Key: stored. Limit: billing since 2026-10-23T10:00:00.000Z.')
    expect(out).not.toContain('sk-ant')
  })

  it('off removes the marker and leaves the key', async () => {
    await main(['set'], t.deps)
    const out = await main(['off'], t.deps)
    expect(out).toBe('Managed AI is off. The stored key was left in the vault.')
    expect(existsSync(join(t.storeDir, 'managed-ai.json'))).toBe(false)
    expect(t.vaultData.has('ANTHROPIC_API_KEY')).toBe(true)
  })

  it('anything else is a usage error', async () => {
    await expect(main([], t.deps)).rejects.toThrow('Usage: managed-ai <set|status|off>')
    await expect(main(['bogus'], t.deps)).rejects.toThrow('Usage: managed-ai <set|status|off>')
  })
})
