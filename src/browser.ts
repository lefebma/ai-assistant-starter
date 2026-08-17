import { execFileSync, spawn, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { logger } from './logger.js'

/**
 * Chrome sits somewhere different on every platform, and the old macOS-only
 * constant meant /browser start could never work on the Windows and Linux
 * bundles CI publishes. Ordered per platform: the system-wide install first,
 * then the per-user one.
 */
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    resolve(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    resolve(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
}

/** Exported for tests; callers want launchChrome(). */
export function resolveChromePath(
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync
): string | null {
  return (CHROME_CANDIDATES[platform] ?? []).find(exists) ?? null
}

const CDP_PORT = 9222
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`
const BROWSER_DATA_DIR = resolve(homedir(), '.ai-assistant', 'browser-profile')
const PID_FILE = resolve(homedir(), '.ai-assistant', 'chrome-cdp.pid')

let chromeProcess: ChildProcess | null = null

/**
 * Check if Chrome is already listening on the CDP port
 */
export async function isCdpAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(2000) })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Get Chrome CDP info (browser version, websocket URL, etc.)
 */
export async function getCdpInfo(): Promise<Record<string, string> | null> {
  try {
    const resp = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) return null
    return await resp.json() as Record<string, string>
  } catch {
    return null
  }
}

/**
 * Get list of open tabs/pages via CDP
 */
export async function getCdpPages(): Promise<Array<{ title: string; url: string }>> {
  try {
    const resp = await fetch(`${CDP_ENDPOINT}/json/list`, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) return []
    const pages = await resp.json() as Array<{ title: string; url: string; type: string }>
    return pages
      .filter(p => p.type === 'page')
      .map(p => ({ title: p.title, url: p.url }))
  } catch {
    return []
  }
}

/**
 * Launch Chrome with remote debugging enabled.
 * Uses a separate profile so it doesn't conflict with the user's main Chrome,
 * but you can also attach to an already-running Chrome (see attachToExisting).
 */
export function launchChrome(opts?: { useDefaultProfile?: boolean }): boolean {
  const chromePath = resolveChromePath()
  if (!chromePath) {
    logger.error({ platform: process.platform }, 'Google Chrome not found in any known install location')
    return false
  }

  // Ensure data dir exists
  if (!opts?.useDefaultProfile) {
    mkdirSync(BROWSER_DATA_DIR, { recursive: true })
  }

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]

  if (!opts?.useDefaultProfile) {
    args.push(`--user-data-dir=${BROWSER_DATA_DIR}`)
  }

  try {
    chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    })

    chromeProcess.unref()

    if (chromeProcess.pid) {
      // Save PID for later cleanup
      mkdirSync(resolve(homedir(), '.ai-assistant'), { recursive: true })
      writeFileSync(PID_FILE, String(chromeProcess.pid))
      logger.info({ pid: chromeProcess.pid, port: CDP_PORT }, 'Chrome launched with CDP')
      return true
    }

    return false
  } catch (err) {
    logger.error({ err }, 'Failed to launch Chrome')
    return false
  }
}

/**
 * Stop the Chrome instance we launched
 */
export function stopChrome(): boolean {
  // Try our tracked process first
  if (chromeProcess && chromeProcess.pid) {
    try {
      process.kill(chromeProcess.pid, 'SIGTERM')
      chromeProcess = null
      cleanPidFile()
      logger.info('Chrome stopped via process reference')
      return true
    } catch {
      // Process may have already exited
    }
  }

  // Try PID file
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
      process.kill(pid, 'SIGTERM')
      cleanPidFile()
      logger.info({ pid }, 'Chrome stopped via PID file')
      return true
    } catch {
      cleanPidFile()
    }
  }

  // Last resort: find by port
  if (stopChromeByPort() > 0) {
    logger.info('Chrome stopped via port lookup')
    return true
  }

  return false
}

/** The port lookup shells out; these are injected so tests need no real Chrome. */
export interface PortLookupDeps {
  platform?: string
  exec?: (cmd: string, args: string[]) => string
  kill?: (pid: number) => void
}

/**
 * `lsof` does not exist on Windows, so the port lookup needs its own command
 * there. `netstat -ano` is parsed in JS rather than piped through `findstr`:
 * a pipe would need a shell, and this repo keeps its automation shell-free
 * (see tests/no-bash.test.ts).
 */
function portLookupCommand(platform: string, port: number): { cmd: string; args: string[] } {
  return platform === 'win32'
    ? { cmd: 'netstat', args: ['-ano'] }
    : { cmd: 'lsof', args: ['-ti', `:${port}`] }
}

/** `127.0.0.1:9222` and `[::1]:9222` both keep the port after the last colon. */
function addressPort(addr: string): number | null {
  const i = addr.lastIndexOf(':')
  if (i < 0) return null
  const n = Number(addr.slice(i + 1))
  return Number.isInteger(n) ? n : null
}

/**
 * Pull PIDs out of `netstat -ano`. Only LISTENING rows whose *local* port is
 * ours count: a foreign address of :9222 is some other machine's server, and
 * killing our end of that connection would reap an unrelated process.
 */
export function parseNetstatPids(out: string, port: number): number[] {
  const pids: number[] = []
  for (const line of out.split(/\r?\n/)) {
    // Proto, Local Address, Foreign Address, State, PID
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const [proto, local, , state, pid] = cols
    if (!/^TCP/i.test(proto)) continue
    if (state.toUpperCase() !== 'LISTENING') continue
    if (addressPort(local) !== port) continue
    pids.push(Number(pid))
  }
  return pids
}

/** `lsof -ti` prints one bare PID per line. */
export function parseLsofPids(out: string): number[] {
  return out.split(/\r?\n/).map(l => Number(l.trim()))
}

/**
 * Last-resort reap: the PID file is gone (service restart, crash) but Chrome is
 * still holding the CDP port. Without this an orphaned Chrome can only be
 * closed by hand. Returns how many processes were actually signalled.
 */
export function stopChromeByPort(deps: PortLookupDeps = {}): number {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? ((cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }))
  const kill = deps.kill ?? ((pid: number) => { process.kill(pid, 'SIGTERM') })

  let pids: number[]
  try {
    const { cmd, args } = portLookupCommand(platform, CDP_PORT)
    const out = exec(cmd, args)
    pids = platform === 'win32' ? parseNetstatPids(out, CDP_PORT) : parseLsofPids(out)
  } catch {
    // Nothing on the port, or no lookup tool available. Degrade quietly.
    return 0
  }

  // PID 0 is the Windows Idle process, and on POSIX process.kill(0) signals our
  // own process group. Never a valid target either way.
  const targets = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0))]

  let stopped = 0
  for (const pid of targets) {
    try {
      kill(pid)
      stopped++
    } catch { /* already exited */ }
  }
  return stopped
}

function cleanPidFile(): void {
  try { unlinkSync(PID_FILE) } catch { /* ignore */ }
}

/**
 * Get status summary for the /browser command
 */
export async function getBrowserStatus(): Promise<string> {
  const available = await isCdpAvailable()
  if (!available) {
    // Distinguish "not started" from "cannot start": /browser start would just
    // fail silently on a machine with no Chrome, which reads as a broken bot.
    return resolveChromePath()
      ? 'Chrome CDP: not running\nUse /browser start to launch'
      : 'Chrome CDP: not running\nGoogle Chrome is not installed, so /browser start has nothing to launch.\nThe assistant can still browse using its own bundled browser.'
  }

  const info = await getCdpInfo()
  const pages = await getCdpPages()

  const lines = [
    `Chrome CDP: active on port ${CDP_PORT}`,
    info?.['Browser'] ? `Browser: ${info['Browser']}` : null,
    `Open tabs: ${pages.length}`,
  ].filter(Boolean)

  if (pages.length > 0 && pages.length <= 10) {
    lines.push('')
    for (const p of pages) {
      const title = p.title || '(untitled)'
      const url = p.url.length > 60 ? p.url.slice(0, 57) + '...' : p.url
      lines.push(`  ${title} - ${url}`)
    }
  }

  return lines.join('\n')
}

/** CDP endpoint URL for Playwright MCP config */
export const CDP_ENDPOINT_URL = CDP_ENDPOINT

/** CDP port number */
export const CDP_PORT_NUMBER = CDP_PORT
