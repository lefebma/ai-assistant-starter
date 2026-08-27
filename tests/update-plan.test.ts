import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  detectInstallKind,
  bundleAssetName,
  planUpdate,
  pickReleaseAsset,
  BUNDLE_PAYLOAD_PATHS,
  SOURCE_ENGINE_PATHS,
  SOURCE_INSTALL_ARGS,
  PRESERVED_PATHS,
} from '../src/update/plan.js'

describe('detectInstallKind', () => {
  it('calls an installer bundle a bundle (compiled app, production deps, no toolchain)', () => {
    expect(detectInstallKind({ hasCompiledApp: true, hasDependencies: true, hasBuildToolchain: false })).toBe('bundle')
  })

  it('calls a developer clone a source install', () => {
    expect(detectInstallKind({ hasCompiledApp: true, hasDependencies: true, hasBuildToolchain: true })).toBe('source')
  })

  it('calls a fresh clone a source install', () => {
    expect(detectInstallKind({ hasCompiledApp: false, hasDependencies: false, hasBuildToolchain: false })).toBe('source')
  })
})

describe('bundleAssetName', () => {
  it('matches the artifact name build-installer publishes', () => {
    expect(bundleAssetName('1.14.3', 'darwin', 'arm64')).toBe('ai-assistant-v1.14.3-darwin-arm64.tar.gz')
  })

  it('tolerates a leading v on the version', () => {
    expect(bundleAssetName('v1.14.3', 'win32', 'x64')).toBe('ai-assistant-v1.14.3-win32-x64.tar.gz')
  })
})

describe('pickReleaseAsset', () => {
  const assets = [
    { name: 'ai-assistant-v1.14.3-darwin-arm64.tar.gz', browser_download_url: 'https://example.test/mac.tar.gz' },
    { name: 'ai-assistant-v1.14.3-win32-x64.tar.gz', browser_download_url: 'https://example.test/win.tar.gz' },
  ]

  it('returns the download url for this platform', () => {
    expect(pickReleaseAsset(assets, 'ai-assistant-v1.14.3-win32-x64.tar.gz')).toBe('https://example.test/win.tar.gz')
  })

  it('returns null when this platform was never published', () => {
    expect(pickReleaseAsset(assets, 'ai-assistant-v1.14.3-linux-x64.tar.gz')).toBeNull()
  })

  it('returns null for a release with no assets at all', () => {
    expect(pickReleaseAsset([], 'ai-assistant-v1.14.3-darwin-arm64.tar.gz')).toBeNull()
  })
})

describe('bundle swap path lists', () => {
  it('never replaces a path the user owns', () => {
    const collisions = BUNDLE_PAYLOAD_PATHS.filter((p) => PRESERVED_PATHS.includes(p))
    expect(collisions).toEqual([])
  })

  it('replaces the compiled app so an update actually changes what runs', () => {
    expect(BUNDLE_PAYLOAD_PATHS).toContain('dist')
    expect(BUNDLE_PAYLOAD_PATHS).toContain('VERSION')
  })

  it('keeps the credentials and data a reinstall must not touch', () => {
    for (const p of ['.env', 'store', 'projects', 'skills', 'CLAUDE.md', 'PERSONALITY.md']) {
      expect(PRESERVED_PATHS).toContain(p)
    }
  })
})

describe('source update', () => {
  // havn-test, 2026-08-22: /update from 1.16.0 ran `npm install --production`,
  // which pruned devDependencies (typescript), then `npm run build` died with
  // "tsc: not found" and the rollback died the same way.
  it('installs with the build toolchain: never prunes devDependencies', () => {
    const pruning = SOURCE_INSTALL_ARGS.filter((a) => /production|omit=dev|only=prod/.test(a))
    expect(pruning).toEqual([])
    expect(SOURCE_INSTALL_ARGS[0]).toBe('ci')
  })

  it('swaps the lockfile with package.json so the install is the one the new version was built with', () => {
    expect(SOURCE_ENGINE_PATHS).toContain('package.json')
    expect(SOURCE_ENGINE_PATHS).toContain('package-lock.json')
    expect(SOURCE_ENGINE_PATHS).toContain('src')
    expect(SOURCE_ENGINE_PATHS).toContain('VERSION')
  })

  it('never replaces a path the user owns', () => {
    const collisions = SOURCE_ENGINE_PATHS.filter((p) => PRESERVED_PATHS.includes(p))
    expect(collisions).toEqual([])
  })
})

describe('planUpdate', () => {
  const base = { currentVersion: '1.14.2', latestVersion: '1.14.3', updateAvailable: true, assetUrl: null }

  it('swaps the payload when a bundle install has a published asset for its platform', () => {
    const plan = planUpdate({ ...base, kind: 'bundle', assetUrl: 'https://example.test/a.tar.gz' })
    expect(plan.action).toBe('replace-bundle')
  })

  it('does nothing destructive when a bundle install has no published asset', () => {
    const plan = planUpdate({ ...base, kind: 'bundle', assetUrl: null })
    expect(plan.action).toBe('none')
    expect(plan.message).toMatch(/1\.14\.3/)
  })

  it('never rebuilds from source on a bundle install', () => {
    const plan = planUpdate({ ...base, kind: 'bundle', assetUrl: null })
    expect(plan.action).not.toBe('rebuild-from-source')
  })

  it('rebuilds from source on a clone install', () => {
    const plan = planUpdate({ ...base, kind: 'source' })
    expect(plan.action).toBe('rebuild-from-source')
  })

  it('does nothing when already on the latest version', () => {
    const plan = planUpdate({ ...base, kind: 'source', updateAvailable: false, latestVersion: '1.14.2' })
    expect(plan.action).toBe('none')
    expect(plan.message).toMatch(/latest/i)
  })

  it('reports the check error instead of guessing', () => {
    const plan = planUpdate({
      ...base,
      kind: 'source',
      updateAvailable: false,
      latestVersion: null,
      error: 'GitHub returned 503',
    })
    expect(plan.action).toBe('none')
    expect(plan.message).toMatch(/503/)
  })
})

describe('public/ is deliverable by an update', () => {
  // The voice UI shipped to havn-test by hand copy because public/ was in
  // none of the three path lists: no update of either kind could deliver it,
  // and merging alone would not have put the page on any box.
  it('is replaced by a source update', () => {
    expect(SOURCE_ENGINE_PATHS).toContain('public')
  })

  it('is swapped in by a bundle update', () => {
    expect(BUNDLE_PAYLOAD_PATHS).toContain('public')
  })

  it('is engine, not user content, so it is not preserved', () => {
    expect(PRESERVED_PATHS).not.toContain('public')
  })

  // A path the updater swaps but the installer never stages is a path no
  // bundle can deliver: the swap silently skips what is missing from the
  // payload, so the gap looks like a working update that changes nothing.
  it('keeps the installer payload in lockstep with the bundle swap list', () => {
    const installer = readFileSync(resolve(__dirname, '../scripts/build-installer.ts'), 'utf-8')
    const appFiles = installer.match(/const APP_FILES = \[(.*?)\]/s)?.[1]
    expect(appFiles).toBeDefined()
    const staged = [...appFiles!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(staged).toContain('public')

    // node_modules is deliberately swapped but not staged by APP_FILES: the
    // installer builds it separately against the pinned runtime.
    const swappedButNeverStaged = BUNDLE_PAYLOAD_PATHS
      .filter((p) => p !== 'node_modules')
      .filter((p) => !staged.includes(p))
    expect(swappedButNeverStaged).toEqual([])
  })
})
