/**
 * Asking the bundled Claude binary whether this machine is signed in.
 *
 * `claude auth status --json` answers authoritatively and offline (it reads
 * the local credential store, which is the macOS login Keychain on darwin and
 * ~/.claude/.credentials.json elsewhere). That is worth far more than checking
 * either location directly: the store's shape is Claude Code's business and
 * has already moved once.
 *
 * The exit code alone is not enough. Older builds print a JSON body and still
 * exit 0 when logged out, so the body is what we read; a non-zero exit with no
 * parseable body is treated as "cannot tell", not as "signed in".
 */
import { spawnSync } from 'node:child_process'

export type AuthStatus = {
  loggedIn: boolean
  /** Human-readable one-liner for the self-test and setup output. */
  detail: string
}

/**
 * Parse `claude auth status --json`. Unparseable output means we could not
 * establish a login, which is the safe direction to fail: a false "signed in"
 * sends someone away from an install that cannot answer a message.
 */
export function parseAuthStatus(stdout: string): AuthStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { loggedIn: false, detail: 'could not read authentication status' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { loggedIn: false, detail: 'could not read authentication status' }
  }

  const record = parsed as Record<string, unknown>
  if (record.loggedIn !== true) return { loggedIn: false, detail: 'not signed in' }

  const method = typeof record.authMethod === 'string' ? record.authMethod : 'unknown'
  const plan = typeof record.subscriptionType === 'string' ? record.subscriptionType : null
  const email = typeof record.email === 'string' ? record.email : null

  // An API key counts as authenticated to Claude Code, so loggedIn is true for
  // both routes. Saying "signed in on this machine" to someone who actually
  // set a key sends them looking for a sign-in they never made, so name which
  // one is in play.
  const parts = [describeMethod(method)]
  if (plan) parts.push(`${plan} plan`)
  if (email) parts.push(email)
  return { loggedIn: true, detail: parts.join(', ') }
}

function describeMethod(method: string): string {
  if (method === 'api_key') return 'using an API key'
  if (method === 'claude.ai') return 'signed in with a Claude account'
  return `signed in via ${method}`
}

/** Runs a command and returns stdout, or null when it cannot be run at all. */
export type RunCommand = (bin: string, args: string[]) => string | null

/**
 * Default RunCommand. Deliberately ignores the exit status and hands back
 * whatever was printed: a logged-out build still writes a usable JSON body,
 * and treating a non-zero exit as "no answer" would report every logged-out
 * machine as an unreadable one.
 */
export function spawnClaude(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: 'utf-8', timeout: 20_000 })
  if (r.error) return null
  return typeof r.stdout === 'string' ? r.stdout : null
}

/**
 * Ask the vendored binary about credentials. A null `bin` (platform package
 * missing) is reported as not-signed-in rather than throwing, so setup can
 * still finish and say something useful.
 */
export function checkClaudeAuth(bin: string | null, run: RunCommand): AuthStatus {
  if (!bin) return { loggedIn: false, detail: 'Claude engine not found in this install' }
  const out = run(bin, ['auth', 'status', '--json'])
  if (out === null) return { loggedIn: false, detail: 'could not run the Claude engine' }
  return parseAuthStatus(out)
}
