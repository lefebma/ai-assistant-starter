import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import { updateInfo, RESTART_TEXT } from '../public/app/update.js'

type Info = { available: boolean; text: string }
const info = updateInfo as (s: unknown) => Info

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const html = readFileSync(join(APP, 'index.html'), 'utf-8')
const css = readFileSync(join(APP, 'app.css'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

describe('updateInfo', () => {
  it('flags a waiting update with the same words as the banner', () => {
    expect(info({ updateAvailable: true, latestVersion: '1.60.0', dismissed: false })).toEqual({
      available: true,
      text: 'Version 1.60.0 is available. Send /update to install it.',
    })
  })

  it('still flags it after the banner was dismissed', () => {
    expect(info({ updateAvailable: true, latestVersion: '1.60.0', dismissed: true }).available).toBe(true)
  })

  it('does not flag an installed update waiting for a restart, but explains it', () => {
    expect(info({ updateAvailable: false, latestVersion: '1.60.0', restartPending: true })).toEqual({
      available: false,
      text: RESTART_TEXT,
    })
  })

  it('shows nothing when the box is up to date or the status is missing', () => {
    expect(info({ updateAvailable: false, latestVersion: '1.52.2', restartPending: false })).toEqual({ available: false, text: '' })
    expect(info({ updateAvailable: true, latestVersion: null })).toEqual({ available: false, text: '' })
    expect(info(null)).toEqual({ available: false, text: '' })
    expect(info(undefined)).toEqual({ available: false, text: '' })
  })
})

describe('update icon markup', () => {
  const button = html.match(/<button\b[^>]*id="update-flag"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''

  it('sits next to the Settings link, hidden until an update is waiting', () => {
    expect(button).not.toBe('')
    const foot = html.match(/<div class="panel-foot">[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(foot).toContain('id="open-settings"')
    expect(foot).toContain('id="update-flag"')
    expect(button).toMatch(/\shidden[\s>]/)
  })

  it('has an accessible label and a tooltip', () => {
    expect(button).toContain('aria-label="Update available"')
    expect(button).toContain('title="Update available"')
  })

  it('draws a download glyph with a dot above it in the current colour', () => {
    const svg = button.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] ?? ''
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toMatch(/<circle\b[^>]*fill="currentColor"/)
    expect(svg).toMatch(/<path\b/)
  })

  it('uses the accent colour, so it follows the theme', () => {
    expect(css).toMatch(/\.update-flag\s*\{[^}]*color:\s*var\(--accent\)/)
  })

  it('has an update section in Settings to open at', () => {
    const settings = html.match(/<dialog id="settings"[\s\S]*?<\/dialog>/)?.[0] ?? ''
    expect(settings).toMatch(/<section\b[^>]*id="update-section"[^>]*hidden/)
    expect(settings).toContain('id="update-detail"')
  })

  it('reuses the one status request, adding no new calls', () => {
    expect(js.match(/api\.get\('\/api\/web\/status'\)/g) ?? []).toHaveLength(1)
    expect(js).toContain("$('update-flag')")
  })
})
