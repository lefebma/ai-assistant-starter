import { execFileSync, spawn, ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { logger } from './logger.js'

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
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
  if (!existsSync(CHROME_PATH)) {
    logger.error('Chrome not found at expected path')
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
    chromeProcess = spawn(CHROME_PATH, args, {
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
  try {
    const out = execFileSync('lsof', ['-ti', `:${CDP_PORT}`], { encoding: 'utf-8' }).trim()
    if (out) {
      for (const pid of out.split('\n')) {
        try { process.kill(parseInt(pid, 10), 'SIGTERM') } catch { /* ignore */ }
      }
      logger.info('Chrome stopped via port lookup')
      return true
    }
  } catch {
    // No process on port
  }

  return false
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
    return 'Chrome CDP: not running\nUse /browser start to launch'
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
