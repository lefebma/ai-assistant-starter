/**
 * Setup requirement checks. Only a too-old Node is fatal.
 *
 * This deliberately does NOT probe PATH for a `claude` command. The engine
 * ships inside the install (see infra/claude-bin.ts), so a missing global CLI
 * says nothing about whether the assistant will work, and the advice that came
 * with that warning ("npm install -g @anthropic-ai/claude-code") installed a
 * second copy the assistant never calls while leaving the real gap — an
 * account to sign in with — unmentioned. Credentials are now the wizard's
 * question, asked in plain English, and the self-test's backstop.
 */

export interface RequirementIO {
  nodeVersion: string
  /** Path to the Claude engine vendored in this install, or null if absent. */
  bundledClaude: string | null
  /** Whether this machine already has a Claude sign-in. */
  signedIn: boolean
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

  if (io.bundledClaude) {
    report.notes.push('Claude engine bundled with this install')
  } else {
    // Not fatal: an API-key install drives the model directly and never
    // launches this binary. Worth flagging loudly all the same, because on a
    // subscription install it means a broken dependency tree, not a choice.
    report.warnings.push(
      'Claude engine missing from this install (node_modules is incomplete). ' +
        'Re-run the installer, or choose the API key option when asked below.'
    )
  }

  report.notes.push(io.signedIn ? 'Claude account: signed in on this machine' : 'Claude account: not signed in yet')

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
