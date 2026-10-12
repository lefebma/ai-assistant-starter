/**
 * Start the local web setup from a double-click, with no terminal (card #215).
 *
 * The Setup launcher (an .app on macOS, a .cmd on Windows) runs
 * `setup-web --background`, which lands here. It starts the real setup server
 * as a detached child, waits until that answers, and exits, so the launcher's
 * own process (and on Windows its console window) is gone within seconds while
 * the page stays up in the browser. A second double-click finds the page
 * already up and just opens it again.
 *
 * Exit codes are the launcher's whole vocabulary: it shows a fixed message per
 * code rather than echoing output, so nothing here has to be quoted for
 * AppleScript or cmd.
 */

export const LAUNCH_OK = 0
export const LAUNCH_FAILED = 1
export const LAUNCH_ALREADY_SET_UP = 3
export const LAUNCH_PORT_BUSY = 4

/** What is on the setup port right now. */
export type PortState = 'setup' | 'other' | 'free'

export interface LaunchDeps {
  /** A .env means setup already ran; the page would refuse to finish anyway. */
  alreadySetUp: () => boolean
  probe: () => Promise<PortState>
  /** Start the setup server detached; returns a check for whether it has died. */
  startServer: () => { exited: () => boolean }
  openBrowser: () => void
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

export const LAUNCH_WAIT_MS = 15_000
const POLL_MS = 250

export async function launchInBackground(deps: LaunchDeps): Promise<number> {
  if (deps.alreadySetUp()) {
    deps.log('This assistant is already set up. Setup is only for a new install.')
    return LAUNCH_ALREADY_SET_UP
  }

  const before = await deps.probe()
  if (before === 'setup') {
    deps.log('Setup is already open; showing it again.')
    deps.openBrowser()
    return LAUNCH_OK
  }
  if (before === 'other') {
    deps.log('The setup port is in use by something else (is the assistant already running?).')
    return LAUNCH_PORT_BUSY
  }

  // The child opens the browser itself once it is listening.
  const child = deps.startServer()
  for (let waited = 0; waited < LAUNCH_WAIT_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS)
    if ((await deps.probe()) === 'setup') return LAUNCH_OK
    if (child.exited()) break
  }
  deps.log('Setup did not start. See logs/setup-web.log.')
  return LAUNCH_FAILED
}

/**
 * Is the thing on the port our setup page? Its state endpoint answers JSON
 * with a mode; anything else listening there (the assistant, another app) is
 * not ours to open.
 */
export async function probeSetupPort(fetchFn: typeof fetch, port: number): Promise<PortState> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/setup/api/state`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return 'other'
    const body = (await res.json().catch(() => null)) as { mode?: unknown } | null
    return body?.mode === 'local' ? 'setup' : 'other'
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code
    return code === 'ECONNREFUSED' ? 'free' : 'other'
  }
}
