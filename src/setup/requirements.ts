/**
 * Setup requirement checks. Only a too-old Node is fatal: the Claude CLI is
 * required by the DEFAULT engine but not by BYOK installs
 * (AGENT_RUNTIME=ai-sdk), and the wizard runs before that choice is known —
 * so its absence warns instead of blocking the install.
 */

export interface RequirementIO {
  nodeVersion: string
  /** Claude CLI version string, or null when not installed. */
  claudeVersion(): string | null
}

export interface RequirementReport {
  fatal: string | null
  warnings: string[]
  notes: string[]
}

export function checkRequirements(io: RequirementIO): RequirementReport {
  const report: RequirementReport = { fatal: null, warnings: [], notes: [] }

  const major = parseInt(io.nodeVersion.split('.')[0], 10)
  if (major < 20) {
    report.fatal = `Node.js v${io.nodeVersion} — need v20+`
    return report
  }
  report.notes.push(`Node.js v${io.nodeVersion}`)

  const claude = io.claudeVersion()
  if (claude) {
    report.notes.push(`Claude CLI: ${claude}`)
  } else {
    report.warnings.push(
      'Claude CLI not found. The default engine needs it (npm install -g @anthropic-ai/claude-code); ' +
        'BYOK installs (AGENT_RUNTIME=ai-sdk with a provider API key) run without it.'
    )
  }

  return report
}

/** What the wizard can see about the tree it is setting up. */
export interface BuildEnvironment {
  /** dist/src/index.js exists — the app is already compiled. */
  hasCompiledApp: boolean
  /** node_modules/ is populated. */
  hasDependencies: boolean
  /** node_modules/typescript exists — `npm run build` (tsc) can actually run. */
  hasBuildToolchain: boolean
}

export interface BuildDecision {
  build: boolean
  reason: string
}

/**
 * Installer bundles ship a compiled dist/ plus production-only dependencies, so
 * there is nothing to build and no tsc to build it with — running npm there
 * fails (often before that, with no npm on PATH at all, since the bundle brings
 * its own Node). Clone installs still need the full install + compile.
 */
export function planBuildStep(env: BuildEnvironment): BuildDecision {
  if (env.hasCompiledApp && env.hasDependencies && !env.hasBuildToolchain) {
    return { build: false, reason: 'prebuilt bundle — dependencies and compiled app already in place' }
  }
  return { build: true, reason: 'source install — dependencies and a TypeScript build are needed' }
}
