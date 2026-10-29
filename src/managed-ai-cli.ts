import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGED_AI_FILE, clearAiLimit, isManagedAi, readAiLimit } from './ai-limit.js'
import { AI_USAGE_FILE, readAiUsage, readManagedCap, syncUsageCap, utcMonth } from './ai-usage.js'

export interface ManagedAiDeps {
  stdin: () => Promise<string>
  vault: { set(name: string, v: string): void; has(name: string): boolean; get(name: string): string | undefined; delete(name: string): boolean }
  storeDir: string
  envExists: boolean
  /** AGENT_RUNTIME from .env, if set. A managed box ignores it and runs claude. */
  envRuntime?: string
}

const USAGE = 'Usage: managed-ai <set|cap <dollars>|status|off|byok>   (set reads the key from stdin)'
const KEY_NAME = 'ANTHROPIC_API_KEY'

/**
 * First 16 hex of the key's SHA-256. Recorded by `set` so the box can tell the
 * provider's key from one the client brought (card #160), without keeping the
 * key anywhere but the vault.
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)
}

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
function writeMarker(storeDir: string, key: string): void {
  const cap = readManagedCap(storeDir)
  writeFlag(storeDir, { since: new Date().toISOString(), ...(cap ? { capUsd: cap } : {}), keyFingerprint: keyFingerprint(key) })
}

function recordedFingerprint(storeDir: string): string | undefined {
  const fp = readFlag(storeDir).keyFingerprint
  return typeof fp === 'string' && fp ? fp : undefined
}

/**
 * Leave managed mode: the flag, and the pause marker and spend total, which
 * mean nothing on a non-managed box and must not reach the operator's monitor.
 */
function dropManaged(storeDir: string): void {
  rmSync(join(storeDir, MANAGED_AI_FILE), { force: true })
  clearAiLimit(storeDir)
  rmSync(join(storeDir, AI_USAGE_FILE), { force: true })
}

export type ReconcileResult = 'not_managed' | 'managed' | 'recorded' | 'dropped'

/**
 * Run once at boot with the key the box will use (vault, then .env). A managed
 * box whose key is no longer the one `set` stored is on the client's own key,
 * so caps, pauses and the operator's alerts stop (card #160). A flag written
 * before fingerprints existed records the current key: only the provider can
 * set the key on a managed box. No key at all stays managed; the turn reports it.
 */
export function reconcileManagedKey(currentKey: string | undefined, storeDir: string): ReconcileResult {
  if (!isManagedAi(storeDir)) return 'not_managed'
  if (!currentKey?.trim()) return 'managed'
  const recorded = recordedFingerprint(storeDir)
  if (!recorded) {
    writeFlag(storeDir, { ...readFlag(storeDir), keyFingerprint: keyFingerprint(currentKey) })
    return 'recorded'
  }
  if (recorded === keyFingerprint(currentKey)) return 'managed'
  dropManaged(storeDir)
  return 'dropped'
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
      writeMarker(deps.storeDir, key)
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
      const stored = deps.vault.get(KEY_NAME)
      const recorded = managed ? recordedFingerprint(deps.storeDir) : undefined
      const keyText = !stored
        ? 'missing'
        : recorded && recorded !== keyFingerprint(stored)
          ? 'stored, not the managed key (caps stop at the next restart)'
          : 'stored'
      return `Managed: ${managed ? 'yes' : 'no'}. Key: ${keyText}. Limit: ${limit ? `${limit.kind} since ${limit.since}` : 'none'}. Cap: ${capText}. Runtime: ${runtime}.`
    }
    case 'off':
      dropManaged(deps.storeDir)
      return 'Managed AI is off. The stored key was left in the vault.'
    case 'byok': {
      // The client brings their own AI account (card #160). Unlike off, the
      // provider's key leaves the box, so it never becomes an overflow lane.
      if (rest.length > 0) throw new Error('Usage: managed-ai byok   (takes no arguments)')
      if (!isManagedAi(deps.storeDir)) throw new Error('This box is not on a managed key.')
      const recorded = recordedFingerprint(deps.storeDir)
      const stored = deps.vault.get(KEY_NAME)
      const ours = stored !== undefined && (!recorded || recorded === keyFingerprint(stored))
      if (ours) deps.vault.delete(KEY_NAME)
      dropManaged(deps.storeDir)
      const lines = [
        stored !== undefined && !ours
          ? 'Managed AI is off. The key in the vault is not yours, so it was left for the owner.'
          : 'Managed AI is off and your key was removed from this box. The assistant has no AI connection until the owner adds their own (see docs/PROVIDERS.md).',
      ]
      if (deps.envExists) lines.push('Restart the service: sudo systemctl restart havn')
      return lines.join('\n')
    }
    default:
      throw new Error(USAGE)
  }
}
