import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/managed-ai-cli.js'
import { isManagedAi, writeAiLimit, readAiLimit } from '../src/ai-limit.js'
import { readAiUsage, readManagedCap, recordManagedSpend } from '../src/ai-usage.js'

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
    await expect(main(['set'], s.deps)).rejects.toSatisfy((e: Error) => !e.message.includes('hunter2'))
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
    await expect(main(['set', KEY], t.deps)).rejects.toSatisfy((e: Error) => !e.message.includes(KEY))
    expect(t.calls()).toBe(0)
    expect(t.vaultData.size).toBe(0)
    expect(isManagedAi(t.storeDir)).toBe(false)
  })

  it('status reports each state and never prints the key', async () => {
    expect(await main(['status'], t.deps)).toBe('Managed: no. Key: missing. Limit: none. Cap: not recorded. Runtime: claude.')
    await main(['set'], t.deps)
    expect(await main(['status'], t.deps)).toBe('Managed: yes. Key: stored. Limit: none. Cap: not recorded. Runtime: claude.')
    writeAiLimit({ kind: 'billing', since: '2026-10-23T10:00:00.000Z' }, t.storeDir)
    const out = await main(['status'], t.deps)
    expect(out).toBe('Managed: yes. Key: stored. Limit: billing since 2026-10-23T10:00:00.000Z. Cap: not recorded. Runtime: claude.')
    expect(out).not.toContain('sk-ant')
  })

  it('status says an AGENT_RUNTIME in .env is ignored while managed', async () => {
    const s = setup()
    const deps = { ...s.deps, envRuntime: 'ai-sdk' }
    expect(await main(['status'], deps)).toBe('Managed: no. Key: missing. Limit: none. Cap: not recorded. Runtime: ai-sdk.')
    await main(['set'], deps)
    expect(await main(['status'], deps)).toBe(
      'Managed: yes. Key: stored. Limit: none. Cap: not recorded. Runtime: claude (AGENT_RUNTIME=ai-sdk in .env is ignored while managed).'
    )
    expect(await main(['status'], { ...s.deps, envRuntime: 'claude' })).toBe('Managed: yes. Key: stored. Limit: none. Cap: not recorded. Runtime: claude.')
  })

  it('off clears a pause marker too', async () => {
    await main(['set'], t.deps)
    writeAiLimit({ kind: 'spend_limit', since: new Date().toISOString() }, t.storeDir)
    await main(['off'], t.deps)
    expect(readAiLimit(t.storeDir)).toBeNull()
    expect(existsSync(join(t.storeDir, 'ai-limit.json'))).toBe(false)
  })

  it('off removes the marker and leaves the key', async () => {
    await main(['set'], t.deps)
    const out = await main(['off'], t.deps)
    expect(out).toBe('Managed AI is off. The stored key was left in the vault.')
    expect(existsSync(join(t.storeDir, 'managed-ai.json'))).toBe(false)
    expect(t.vaultData.has('ANTHROPIC_API_KEY')).toBe(true)
  })

  it('cap needs a managed box and a non-negative number', async () => {
    await expect(main(['cap', '50'], t.deps)).rejects.toThrow('not on a managed key')
    await main(['set'], t.deps)
    for (const bad of [[], ['abc'], ['-5'], ['10', '20']]) {
      await expect(main(['cap', ...bad], t.deps)).rejects.toThrow('Usage: managed-ai cap <dollars>')
    }
  })

  it('cap records the monthly cap, set keeps it, 0 clears it', async () => {
    await main(['set'], t.deps)
    expect(await main(['cap', '50'], t.deps)).toBe('Cap recorded: $50.00 a month. The owner gets a heads-up at 80%.')
    expect(readManagedCap(t.storeDir)).toBe(50)
    await main(['set'], t.deps)
    expect(readManagedCap(t.storeDir)).toBe(50)
    expect(await main(['cap', '0'], t.deps)).toBe('Cap cleared. The 80% heads-up is off.')
    expect(readManagedCap(t.storeDir)).toBeUndefined()
    expect(isManagedAi(t.storeDir)).toBe(true)
  })

  it('status shows the cap and this month\'s spend', async () => {
    await main(['set'], t.deps)
    await main(['cap', '50'], t.deps)
    recordManagedSpend(12.5, { storeDir: t.storeDir })
    expect(await main(['status'], t.deps)).toBe(
      'Managed: yes. Key: stored. Limit: none. Cap: $50.00 a month, $12.50 used (25%). Runtime: claude.'
    )
  })

  it('cap updates this month\'s usage file at once; off removes it', async () => {
    await main(['set'], t.deps)
    await main(['cap', '50'], t.deps)
    recordManagedSpend(5, { storeDir: t.storeDir })
    await main(['cap', '80'], t.deps)
    expect(readAiUsage(t.storeDir)?.capUsd).toBe(80)
    await main(['cap', '0'], t.deps)
    expect(readAiUsage(t.storeDir)?.capUsd).toBeUndefined()
    await main(['off'], t.deps)
    expect(readAiUsage(t.storeDir)).toBeNull()
  })

  it('anything else is a usage error', async () => {
    await expect(main([], t.deps)).rejects.toThrow('Usage: managed-ai <set|cap <dollars>|status|off>')
    await expect(main(['bogus'], t.deps)).rejects.toThrow('Usage: managed-ai <set|cap <dollars>|status|off>')
  })
})
