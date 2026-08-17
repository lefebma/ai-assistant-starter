import { describe, it, expect } from 'vitest'
import {
  detectInstallKind,
  bundleAssetName,
  planUpdate,
  pickReleaseAsset,
  BUNDLE_PAYLOAD_PATHS,
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
