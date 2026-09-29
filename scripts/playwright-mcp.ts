/**
 * Launcher for the Playwright MCP server that auto-connects to CDP when a
 * browser is already listening on port 9222 (so the assistant drives your
 * real browser session instead of a fresh one). Without one, it uses Google
 * Chrome when installed and Playwright's bundled Chromium otherwise (hosted
 * VPS boxes have no Chrome). See src/browser-channel.ts.
 *
 * Pinned to the project's local @playwright/mcp install (no npx fetch, no
 * @latest time-bomb); falls back to npx only on a fresh clone before
 * npm install. Reference it from .mcp.json as:
 *   "playwright": { "command": "node", "args": ["dist/scripts/playwright-mcp.js"] }
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'
import { CDP_ENDPOINT, chromeChannelInstalled, playwrightMcpBrowserArgs } from '../src/browser-channel.js'

async function cdpUp(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1000)
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const local = resolve(PROJECT_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js')
  const passthrough = process.argv.slice(2)
  const browserArgs = playwrightMcpBrowserArgs({
    cdpUp: await cdpUp(),
    chromeInstalled: chromeChannelInstalled(),
    passthrough,
  })

  const [cmd, args, useShell] = existsSync(local)
    ? [process.execPath, [local, ...browserArgs, ...passthrough], false]
    : ['npx', ['@playwright/mcp@latest', ...browserArgs, ...passthrough], process.platform === 'win32']

  const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell })
  child.on('error', (err) => {
    console.error(`Failed to launch Playwright MCP: ${String(err)}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

main()
