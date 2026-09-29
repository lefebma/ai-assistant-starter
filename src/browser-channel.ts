/**
 * Which browser the Playwright MCP server should drive.
 *
 * @playwright/mcp defaults to the "chrome" channel: the system Google Chrome,
 * at the one location Playwright checks per platform. Where that is missing
 * (every hosted VPS, and any desktop without Chrome) each browser tool call
 * failed with "Chromium distribution 'chrome' is not found". The launcher now
 * falls back to Playwright's bundled Chromium instead.
 *
 * Kept free of side effects and logging on purpose: the launcher speaks MCP
 * over stdout, so anything it imports must not write there.
 */
import { existsSync } from 'node:fs'

export const CDP_ENDPOINT = 'http://127.0.0.1:9222'

// Mirrors playwright-core's registry for the "chrome" channel. Deliberately
// narrower than resolveChromePath() in browser.ts, which also accepts a distro
// Chromium for /browser start; the chrome channel never looks there.
const CHROME_CHANNEL_PATHS: Record<string, string[]> = {
  linux: ['/opt/google/chrome/chrome'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
}
const WINDOWS_PREFIX_VARS = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']
const WINDOWS_SUFFIX = '\\Google\\Chrome\\Application\\chrome.exe'

export function chromeChannelInstalled(
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env
): boolean {
  const candidates = platform === 'win32'
    ? WINDOWS_PREFIX_VARS.map((v) => env[v]).filter((p): p is string => !!p).map((p) => p + WINDOWS_SUFFIX)
    : CHROME_CHANNEL_PATHS[platform] ?? []
  return candidates.some(exists)
}

export interface BrowserArgsInput {
  /** A debuggable browser (/browser start) is already listening. */
  cdpUp: boolean
  chromeInstalled: boolean
  /** Arguments the operator passed through from .mcp.json. */
  passthrough: string[]
}

export function playwrightMcpBrowserArgs({ cdpUp, chromeInstalled, passthrough }: BrowserArgsInput): string[] {
  if (cdpUp) return ['--cdp-endpoint', CDP_ENDPOINT]
  const chosen = passthrough.some((a) => a === '--browser' || a.startsWith('--browser='))
  if (chosen || chromeInstalled) return []
  return ['--browser', 'chromium']
}
