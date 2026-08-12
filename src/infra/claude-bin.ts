/**
 * Locating the Claude binary the app actually runs on.
 *
 * There are two of these on a developer's machine and only one on a
 * customer's. @anthropic-ai/claude-agent-sdk ships a native `claude` for the
 * host platform as an optional dependency, and `query()` uses that built-in
 * executable unless `pathToClaudeCodeExecutable` says otherwise (which this
 * codebase never does). A separately installed Claude Code on PATH is a
 * different copy that the assistant never calls.
 *
 * Setup used to probe PATH for a bare `claude` and warn when it found nothing,
 * which told a fresh customer to `npm install -g @anthropic-ai/claude-code`.
 * That command installs a second Claude the assistant will not use, and it
 * does nothing about the thing that was actually missing: an account to sign
 * in with. We resolve the bundled binary instead, and use it to ask about
 * credentials.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type Exists = (path: string) => boolean

/**
 * SDK platform package names, most likely first. The musl variants are listed
 * after glibc because npm installs whichever matches the host and only one
 * will be present; ordering just decides which we notice first.
 */
export function sdkPlatformPackages(platform: string, arch: string): string[] {
  if (platform === 'linux') {
    return [`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`]
  }
  return [`claude-agent-sdk-${platform}-${arch}`]
}

/** Executable name inside the platform package. */
function binName(platform: string): string {
  return platform === 'win32' ? 'claude.exe' : 'claude'
}

/** Every path the vendored binary could plausibly occupy, most likely first. */
export function bundledClaudeCandidates(projectRoot: string, platform: string, arch: string): string[] {
  const paths: string[] = []
  for (const pkg of sdkPlatformPackages(platform, arch)) {
    // Both names are tried because the Windows package has not been inspected
    // on a Windows host; a wrong guess here would silently report "no engine"
    // on the one platform we cannot test locally.
    for (const name of [binName(platform), 'claude']) {
      const candidate = join(projectRoot, 'node_modules', '@anthropic-ai', pkg, name)
      if (!paths.includes(candidate)) paths.push(candidate)
    }
  }
  return paths
}

/**
 * Resolve the Claude binary vendored inside this install, or null when the
 * platform package is missing (a broken or partial `npm install`).
 * `CLAUDE_BIN` in the environment always wins, matching resolveGogBin.
 */
export function resolveBundledClaude(
  env: Record<string, string | undefined>,
  projectRoot: string,
  platform: string = process.platform,
  arch: string = process.arch,
  exists: Exists = existsSync,
): string | null {
  const override = env['CLAUDE_BIN']?.trim()
  if (override) return override

  return bundledClaudeCandidates(projectRoot, platform, arch).find(exists) ?? null
}
