/**
 * Self-test: verifies an install can actually do its job.
 *
 * Everything here is offline by default (no network, no model call), so it
 * still runs at the end of a fresh install. What changed is what counts as
 * passing. It used to check only that a runtime could be *selected* and
 * reported "PASS" on a machine with no account behind that runtime, which is
 * the exact install that then fails to answer its owner's first message. The
 * credentials check now fails instead.
 *
 * Two flags qualify that:
 *   --skip-auth  structural checks only. CI uses this: it verifies freshly
 *                built bundles, which correctly have no account attached.
 *   --live       additionally make one real model call. The only check that
 *                proves the credentials work rather than merely exist, so it
 *                is what to run at the end of a customer install.
 *
 * Invoked via `node dist/src/index.js --selftest [--skip-auth] [--live]`.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CredentialStatus } from './setup/credentials.js'

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

export interface SelfTestOptions {
  quiet?: boolean
  /** Structural checks only — skip the credentials check. */
  skipAuth?: boolean
  /** Add a real one-shot model call. Costs a few tokens and needs network. */
  live?: boolean
  /** Test seam: stand in for the real credential lookup. */
  credentials?: () => Promise<CredentialStatus>
}

/**
 * Resolve whether this install has usable credentials. Exported for the setup
 * wizard, which asks the same question at the end of an install call so the
 * person running it finds out while they are still there to fix it.
 */
export async function credentialStatus(): Promise<CredentialStatus> {
  const { readEnvFile, PROJECT_ROOT } = await import('./env.js')
  const { getSecret } = await import('./vault/index.js')
  const { resolveBundledClaude } = await import('./infra/claude-bin.js')
  const { checkClaudeAuth, spawnClaude } = await import('./infra/claude-auth.js')
  const { checkCredentials } = await import('./setup/credentials.js')

  const env = readEnvFile()
  const read = (name: string) => getSecret(name) ?? env[name] ?? process.env[name]
  const runtime = env.AGENT_RUNTIME?.trim() || process.env.AGENT_RUNTIME?.trim() || 'claude'
  const provider = env.AI_PROVIDER?.trim() || process.env.AI_PROVIDER?.trim()

  // Only the claude runtime can use an interactive sign-in, and asking costs a
  // subprocess spawn, so skip it entirely on the API-key path.
  const auth =
    runtime === 'claude'
      ? checkClaudeAuth(resolveBundledClaude(process.env, PROJECT_ROOT), spawnClaude)
      : { loggedIn: false, detail: '' }

  return checkCredentials({ runtime, provider, env: read, signedIn: auth.loggedIn, signInDetail: auth.detail })
}

export function defaultChecks(opts: SelfTestOptions = {}): Check[] {
  const checks: Check[] = [
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

  if (!opts.skipAuth) {
    checks.push({
      name: 'credentials',
      run: async () => {
        const status = await (opts.credentials ?? credentialStatus)()
        if (!status.ok) throw new Error([status.detail, status.remedy].filter(Boolean).join('. '))
        return status.detail
      },
    })
  }

  if (opts.live) {
    checks.push({
      name: 'live-model-call',
      run: async () => {
        const { getAgentRuntime } = await import('./runtime/index.js')
        const runtime = getAgentRuntime('chat')
        const text = await runtime.runOnce('Reply with exactly one word: ready')
        if (!text?.trim()) throw new Error(`'${runtime.id}' runtime returned no text`)
        return `'${runtime.id}' answered: ${text.trim().slice(0, 60)}`
      },
    })
  }

  return checks
}

export async function runSelfTest(opts: SelfTestOptions = {}): Promise<boolean> {
  const { ok, results } = await runChecks(defaultChecks(opts))
  if (!opts.quiet) {
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.detail}`)
    }
    console.log(ok ? '\nself-test: PASS' : '\nself-test: FAIL')
  }
  return ok
}
