/**
 * Update planning. Pure decisions, no I/O, so the rules are testable.
 *
 * There are two kinds of install and they update in completely different ways:
 *
 *   source  — a git clone or source download. Has the TypeScript toolchain, so
 *             it updates the way it always has: fetch the repo, replace engine
 *             files, `npm install` + `npm run build`.
 *
 *   bundle  — an installer payload. Ships a compiled dist/ and production-only
 *             dependencies, and brings its own Node, so there is frequently no
 *             system npm on PATH at all and never a tsc to build with. The
 *             source path cannot work here: it would replace src/ and VERSION,
 *             fail at npm, and then fail its own rollback at npm too, leaving a
 *             half-updated tree whose VERSION lies about what is running.
 *             Bundles update by swapping in a published release payload.
 *
 * When a bundle has no published asset for its platform, the only safe action
 * is to do nothing and say so. Never start an update that cannot finish.
 */

export type InstallKind = 'bundle' | 'source'

/** What the updater can see about the tree it is updating. */
export interface InstallEnvironment {
  /** dist/src/index.js exists — the app is already compiled. */
  hasCompiledApp: boolean
  /** node_modules/ is populated. */
  hasDependencies: boolean
  /** node_modules/typescript exists — `npm run build` (tsc) can actually run. */
  hasBuildToolchain: boolean
}

export function detectInstallKind(env: InstallEnvironment): InstallKind {
  return env.hasCompiledApp && env.hasDependencies && !env.hasBuildToolchain ? 'bundle' : 'source'
}

/**
 * The artifact name scripts/build-installer.ts writes, and therefore the
 * release asset to look for. Keep these two in lockstep.
 */
export function bundleAssetName(version: string, platform: string, arch: string): string {
  return `ai-assistant-v${version.replace(/^v/, '')}-${platform}-${arch}.tar.gz`
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** Find this platform's tarball in a GitHub release. Null means not published. */
export function pickReleaseAsset(assets: ReleaseAsset[], wantedName: string): string | null {
  return assets.find((a) => a.name === wantedName)?.browser_download_url ?? null
}

/**
 * Files and directories the user owns. Never overwritten by any update path.
 */
export const PRESERVED_PATHS = ['.env', 'CLAUDE.md', 'PERSONALITY.md', 'skills', 'projects', 'store', 'seed-jobs.json']

/**
 * What a bundle update swaps in: the app payload from build-installer's
 * APP_FILES, plus node_modules, since a bundle's dependencies are prebuilt
 * against the pinned runtime and travel with the compiled app.
 *
 * `runtime/` is deliberately absent. Replacing the Node binary that is
 * executing the update is a good way to end up with neither the old one nor
 * the new one. A runtime bump ships as a fresh install.
 */
export const BUNDLE_PAYLOAD_PATHS = [
  'dist',
  'node_modules',
  'templates',
  'docs',
  'package.json',
  'package-lock.json',
  'README.md',
  'CHANGELOG.md',
  'VERSION',
  '.env.example',
]

export type UpdateAction = 'replace-bundle' | 'rebuild-from-source' | 'none'

export interface UpdatePlan {
  action: UpdateAction
  message: string
}

export interface UpdateInputs {
  kind: InstallKind
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  /** Release asset for this platform, or null when none is published. */
  assetUrl: string | null
  error?: string
}

export function planUpdate(input: UpdateInputs): UpdatePlan {
  if (input.error) {
    return { action: 'none', message: `Update check failed: ${input.error}` }
  }

  if (!input.updateAvailable || !input.latestVersion) {
    return { action: 'none', message: `Already on the latest version (${input.currentVersion}).` }
  }

  if (input.kind === 'source') {
    return {
      action: 'rebuild-from-source',
      message: `Updating from ${input.currentVersion} to ${input.latestVersion}.`,
    }
  }

  if (!input.assetUrl) {
    return {
      action: 'none',
      message:
        `Version ${input.latestVersion} is available, but no installer package has been published for ` +
        `this platform yet. This install updates by installing the new package, not by rebuilding from ` +
        `source, so nothing has been changed. You are still on ${input.currentVersion} and everything works.`,
    }
  }

  return {
    action: 'replace-bundle',
    message: `Updating from ${input.currentVersion} to ${input.latestVersion}.`,
  }
}
