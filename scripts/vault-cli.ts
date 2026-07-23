/**
 * BYOK vault CLI (Phase 4 slice a).
 *
 * Manage the local encrypted secret store. Secret values are read from stdin by
 * default so they never land in shell history, argv, or the process list.
 *
 * Usage (run compiled, with the service's pinned node):
 *   echo -n 'sk-...' | node dist/scripts/vault-cli.js set OPENAI_API_KEY
 *   node dist/scripts/vault-cli.js get OPENAI_API_KEY      # prints the value
 *   node dist/scripts/vault-cli.js list                    # names only
 *   node dist/scripts/vault-cli.js rm OPENAI_API_KEY
 *   node dist/scripts/vault-cli.js migrate OPENAI_API_KEY ANTHROPIC_API_KEY
 *
 * migrate copies the named keys from .env into the vault (non-destructive: the
 * values stay in .env until you remove them yourself). Point at a different
 * vault directory with AGENT_VAULT_DIR (the installer uses the OS config dir).
 */
import { readEnvFile } from '../src/env.js'
import { SecretVault } from '../src/vault/index.js'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

const USAGE = 'usage: vault <set|get|list|rm|migrate> [name...]'

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const dir = process.env.AGENT_VAULT_DIR
  const vault = new SecretVault(dir ? { dir } : {})

  switch (cmd) {
    case 'set': {
      const name = rest[0]
      if (!name) throw new Error('set: missing NAME')
      // Prefer stdin (safe); fall back to an arg with a warning.
      let value = rest[1]
      if (value === undefined) {
        value = (await readStdin()).replace(/\r?\n$/, '')
      } else {
        console.warn('warning: passing the value as an argument can leak it into shell history; prefer stdin')
      }
      if (!value) throw new Error('set: empty value')
      vault.set(name, value)
      console.log(`set ${name} (${value.length} chars)`) // never echo the value
      break
    }
    case 'get': {
      const name = rest[0]
      if (!name) throw new Error('get: missing NAME')
      const value = vault.get(name)
      if (value === undefined) {
        console.error(`no secret named ${name}`)
        process.exit(1)
      }
      process.stdout.write(value + '\n')
      break
    }
    case 'list': {
      const names = vault.list()
      console.log(names.length ? names.join('\n') : '(vault is empty)')
      break
    }
    case 'rm':
    case 'delete': {
      const name = rest[0]
      if (!name) throw new Error('rm: missing NAME')
      console.log(vault.delete(name) ? `removed ${name}` : `no secret named ${name}`)
      break
    }
    case 'migrate': {
      if (!rest.length) throw new Error('migrate: name at least one key to copy from .env')
      const env = readEnvFile()
      const migrated: string[] = []
      const skipped: string[] = []
      for (const name of rest) {
        if (env[name] !== undefined && env[name] !== '') {
          vault.set(name, env[name])
          migrated.push(name)
        } else {
          skipped.push(name)
        }
      }
      console.log(`migrated from .env: ${migrated.join(', ') || '(none)'}`)
      if (skipped.length) console.log(`not found in .env (skipped): ${skipped.join(', ')}`)
      console.log('note: values remain in .env too; remove them there once you have verified the vault.')
      break
    }
    default:
      console.log(USAGE)
      process.exit(cmd ? 1 : 0)
  }
}

main().catch(err => {
  console.error(String((err as Error)?.message ?? err))
  process.exit(1)
})
