/**
 * managed-ai: operator command to put a provider-managed AI key on a box.
 *
 *   printf '%s' "$KEY" | node dist/scripts/managed-ai.js set
 *   printf '%s' "$KEY" | node dist/scripts/managed-ai.js set --open-model   (US host key, card #268)
 *   node dist/scripts/managed-ai.js price 0.30 1.20   (open model: dollars per million tokens in, out)
 *   node dist/scripts/managed-ai.js cap <dollars>
 *   node dist/scripts/managed-ai.js status
 *   node dist/scripts/managed-ai.js off
 *   node dist/scripts/managed-ai.js byok   (client brings their own AI account; removes the key)
 *
 * The key is read from stdin only (never argv) and stored in the vault. Logic
 * lives in src/managed-ai-cli.ts. stdout carries the reply; errors go to stderr.
 */
process.env.LOG_DEST = 'stderr'

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

try {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { main } = await import('../src/managed-ai-cli.js')
  const { STORE_DIR, PROJECT_ROOT } = await import('../src/config.js')
  const { SecretVault } = await import('../src/vault/index.js')
  const { readEnvFile } = await import('../src/env.js')
  const dir = process.env.AGENT_VAULT_DIR
  const out = await main(process.argv.slice(2), {
    stdin: readStdin,
    vault: new SecretVault(dir ? { dir } : {}),
    storeDir: STORE_DIR,
    envExists: existsSync(join(PROJECT_ROOT, '.env')),
    ...(() => {
      const env = readEnvFile(['AGENT_RUNTIME', 'AI_BASE_URL', 'AI_MODEL'])
      return { envRuntime: env.AGENT_RUNTIME, envBaseUrl: env.AI_BASE_URL, envModel: env.AI_MODEL }
    })(),
  })
  process.stdout.write(`${out}\n`, () => process.exit(0))
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`, () => process.exit(1))
}
