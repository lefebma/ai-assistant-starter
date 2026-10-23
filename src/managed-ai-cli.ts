import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGED_AI_FILE, clearAiLimit, isManagedAi, readAiLimit } from './ai-limit.js'

export interface ManagedAiDeps {
  stdin: () => Promise<string>
  vault: { set(name: string, v: string): void; has(name: string): boolean }
  storeDir: string
  envExists: boolean
}

const USAGE = 'Usage: managed-ai <set|status|off>   (set reads the key from stdin)'
const KEY_NAME = 'ANTHROPIC_API_KEY'

function writeMarker(storeDir: string): void {
  mkdirSync(storeDir, { recursive: true })
  const target = join(storeDir, MANAGED_AI_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ since: new Date().toISOString() }, null, 2) + '\n')
  renameSync(tmp, target)
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
    case 'status': {
      const limit = readAiLimit(deps.storeDir)
      return `Managed: ${isManagedAi(deps.storeDir) ? 'yes' : 'no'}. Key: ${deps.vault.has(KEY_NAME) ? 'stored' : 'missing'}. Limit: ${limit ? `${limit.kind} since ${limit.since}` : 'none'}.`
    }
    case 'off':
      rmSync(join(deps.storeDir, MANAGED_AI_FILE), { force: true })
      return 'Managed AI is off. The stored key was left in the vault.'
    default:
      throw new Error(USAGE)
  }
}
