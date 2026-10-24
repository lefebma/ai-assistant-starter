import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGED_AI_FILE, clearAiLimit, isManagedAi, readAiLimit } from './ai-limit.js'
import { AI_USAGE_FILE, readAiUsage, readManagedCap, syncUsageCap, utcMonth } from './ai-usage.js'

export interface ManagedAiDeps {
  stdin: () => Promise<string>
  vault: { set(name: string, v: string): void; has(name: string): boolean }
  storeDir: string
  envExists: boolean
  /** AGENT_RUNTIME from .env, if set. A managed box ignores it and runs claude. */
  envRuntime?: string
}

const USAGE = 'Usage: managed-ai <set|cap <dollars>|status|off>   (set reads the key from stdin)'
const KEY_NAME = 'ANTHROPIC_API_KEY'

function readFlag(storeDir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir, MANAGED_AI_FILE), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeFlag(storeDir: string, flag: Record<string, unknown>): void {
  mkdirSync(storeDir, { recursive: true })
  const target = join(storeDir, MANAGED_AI_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(flag, null, 2) + '\n')
  renameSync(tmp, target)
}

/** A fresh flag keeps a cap already recorded, so re-running set never drops it. */
function writeMarker(storeDir: string): void {
  const cap = readManagedCap(storeDir)
  writeFlag(storeDir, { since: new Date().toISOString(), ...(cap ? { capUsd: cap } : {}) })
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** Errors carry operator-safe text only; the key is never included. */
export async function main(argv: string[], deps: ManagedAiDeps): Promise<string> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'set': {
      // Any extra argument could be the key; refuse before touching stdin.
      if (rest.length > 0) throw new Error('Pass the key on stdin, not on the command line.')
      const key = (await deps.stdin()).trim()
      if (!key) throw new Error('No key received on stdin.')
      if (!key.startsWith('sk-ant-api')) throw new Error("That doesn't look like an Anthropic API key.")
      deps.vault.set(KEY_NAME, key)
      writeMarker(deps.storeDir)
      clearAiLimit(deps.storeDir)
      const lines = ['Managed AI key saved.']
      if (deps.envExists) lines.push('Restart the service to use it: sudo systemctl restart havn')
      return lines.join('\n')
    }
    case 'cap': {
      if (!isManagedAi(deps.storeDir)) throw new Error('This box is not on a managed key. Run set first.')
      const value = Number(rest[0])
      if (rest.length !== 1 || !Number.isFinite(value) || value < 0) {
        throw new Error('Usage: managed-ai cap <dollars>   (the monthly limit set in the Console; 0 turns the heads-up off)')
      }
      const flag = readFlag(deps.storeDir)
      if (value === 0) delete flag.capUsd
      else flag.capUsd = value
      writeFlag(deps.storeDir, flag)
      syncUsageCap(deps.storeDir)
      return value === 0
        ? 'Cap cleared. The 80% heads-up is off.'
        : `Cap recorded: ${money(value)} a month. The owner gets a heads-up at 80%.`
    }
    case 'status': {
      const limit = readAiLimit(deps.storeDir)
      const managed = isManagedAi(deps.storeDir)
      const envRuntime = deps.envRuntime?.trim() || undefined
      const runtime = managed
        ? envRuntime && envRuntime !== 'claude'
          ? `claude (AGENT_RUNTIME=${envRuntime} in .env is ignored while managed)`
          : 'claude'
        : envRuntime ?? 'claude'
      const cap = readManagedCap(deps.storeDir)
      const usage = readAiUsage(deps.storeDir)
      const spent = usage && usage.month === utcMonth(new Date()) ? usage.usd : 0
      const capText = cap ? `${money(cap)} a month, ${money(spent)} used (${Math.round((spent / cap) * 100)}%)` : 'not recorded'
      return `Managed: ${managed ? 'yes' : 'no'}. Key: ${deps.vault.has(KEY_NAME) ? 'stored' : 'missing'}. Limit: ${limit ? `${limit.kind} since ${limit.since}` : 'none'}. Cap: ${capText}. Runtime: ${runtime}.`
    }
    case 'off':
      rmSync(join(deps.storeDir, MANAGED_AI_FILE), { force: true })
      // A pause marker and a spend total mean nothing on a non-managed box; do
      // not leave them behind for the operator's monitor to read.
      clearAiLimit(deps.storeDir)
      rmSync(join(deps.storeDir, AI_USAGE_FILE), { force: true })
      return 'Managed AI is off. The stored key was left in the vault.'
    default:
      throw new Error(USAGE)
  }
}
