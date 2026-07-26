/**
 * Offline self-test (Phase 5 installer): verifies the install is structurally
 * sound — runtime resolves, database opens, vault resolver works — WITHOUT
 * touching the network or requiring credentials, so it can run at the end of
 * a fresh install and inside CI. Missing credentials are reported as details,
 * not failures. Invoked via `node dist/src/index.js --selftest`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface Check {
  name: string
  run: () => Promise<string> | string
}

export async function runChecks(checks: Check[]): Promise<{ ok: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  for (const check of checks) {
    try {
      results.push({ name: check.name, ok: true, detail: await check.run() })
    } catch (err) {
      results.push({ name: check.name, ok: false, detail: String((err as Error)?.message ?? err) })
    }
  }
  return { ok: results.every((r) => r.ok), results }
}

export function defaultChecks(): Check[] {
  return [
    {
      name: 'node-version',
      run: () => {
        const major = parseInt(process.versions.node.split('.')[0], 10)
        if (major < 20) throw new Error(`Node ${process.versions.node} — need v20+`)
        return `v${process.versions.node}`
      },
    },
    {
      name: 'config',
      run: async () => {
        const config = await import('./config.js')
        return config.TELEGRAM_BOT_TOKEN ? 'loaded (bot token configured)' : 'loaded (bot token not set yet — fill .env)'
      },
    },
    {
      name: 'database',
      run: async () => {
        const { initDatabase, getDb } = await import('./db.js')
        initDatabase()
        getDb().prepare('SELECT 1').get()
        return 'opened and initialized'
      },
    },
    {
      name: 'vault',
      run: async () => {
        const { getSecret } = await import('./vault/index.js')
        // Must resolve (to undefined) without throwing on a fresh install.
        getSecret('SELFTEST_NONEXISTENT_KEY')
        return 'secret resolution works (vault -> .env -> environment)'
      },
    },
    {
      name: 'runtime',
      run: async () => {
        const { getAgentRuntime } = await import('./runtime/index.js')
        return `'${getAgentRuntime('chat').id}' selected for chat lane`
      },
    },
    {
      name: 'layout',
      run: async () => {
        const { PROJECT_ROOT } = await import('./env.js')
        if (!existsSync(resolve(PROJECT_ROOT, 'package.json'))) {
          throw new Error(`package.json not found at ${PROJECT_ROOT} — install layout broken`)
        }
        return PROJECT_ROOT
      },
    },
  ]
}

export async function runSelfTest(opts: { quiet?: boolean } = {}): Promise<boolean> {
  const { ok, results } = await runChecks(defaultChecks())
  if (!opts.quiet) {
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`)
    }
    console.log(ok ? '\nself-test: PASS' : '\nself-test: FAIL')
  }
  return ok
}
