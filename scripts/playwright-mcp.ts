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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

  const proxy = proxyArgsFor(process.env.HTTPS_PROXY || process.env.https_proxy, passthrough)
  const proxyArgs = proxy.args
  const [cmd, args, useShell] = existsSync(local)
    ? [process.execPath, [local, ...browserArgs, ...proxyArgs, ...passthrough], false]
    : ['npx', ['@playwright/mcp@latest', ...browserArgs, ...proxyArgs, ...passthrough], process.platform === 'win32']

  const child = spawn(cmd, args, { stdio: 'inherit', shell: useShell })
  child.on('error', (err) => {
    console.error(`Failed to launch Playwright MCP: ${String(err)}`)
    process.exit(1)
  })
  child.on('exit', (code) => { proxy.cleanup(); process.exit(code ?? 1) })
}

/**
 * Egress enforced (card #231): the browser goes through the run's proxy too.
 * Chromium will not take a password from --proxy-server, so when the proxy
 * URL carries the run's secret it goes in a private config file instead, and
 * Playwright answers the proxy's 407 with it. A --config of your own wins;
 * the browser then has no secret and the proxy refuses it (fails closed).
 */
function proxyArgsFor(proxy: string | undefined, passthrough: string[]): { args: string[]; cleanup: () => void } {
  const none = { args: [], cleanup: () => {} }
  if (!proxy || passthrough.some((a) => a.startsWith('--proxy-server'))) return none
  const u = new URL(proxy)
  if (!u.username || passthrough.some((a) => a.startsWith('--config'))) return { args: ['--proxy-server', `${u.protocol}//${u.host}`], cleanup: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'havn-pw-'))
  const file = join(dir, 'config.json')
  const server = `${u.protocol}//${u.host}`
  writeFileSync(file, JSON.stringify({ browser: { launchOptions: { proxy: { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } } }), { mode: 0o600 })
  return { args: ['--config', file], cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

main()
