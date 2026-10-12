/**
 * Web setup (cards #211-#213): the browser alternative to `npm run setup`.
 *
 *   node dist/scripts/setup-web.js [--no-open]           local: opens http://localhost:3030/setup
 *   node dist/scripts/setup-web.js --background          local, from the Setup launcher: starts the
 *                                                        server detached, opens the page, exits
 *   node dist/scripts/setup-web.js --hosted              hosted: serves the one-time link behind the edge
 *   node dist/scripts/setup-web.js --issue-link HOST     hosted: issues a fresh link and prints it
 *
 * It runs on the assistant's own port before the assistant exists, and exits
 * when setup is done so the assistant can start there. On a hosted box,
 * scripts/hosted/enable-setup.ts runs it as the havn-setup service.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../src/env.js'
import { resolveBundledClaude } from '../src/infra/claude-bin.js'
import { checkClaudeAuth, spawnClaude } from '../src/infra/claude-auth.js'
import { isValidHostname } from '../src/deploy/teams-edge.js'
import { SETUP_FINISHED_MARKER } from '../src/deploy/setup-edge.js'
import { defaultVault } from '../src/vault/index.js'
import { checkLink, fileLinkStore, issueLink } from '../src/setup/web/link.js'
import { createSetupServer, type ClaudeSignIn, type SetupMode } from '../src/setup/web/server.js'
import { launchInBackground, probeSetupPort } from '../src/setup/web/launch.js'

const PORT = Number(process.env.HTTP_PORT) || 3030
const links = fileLinkStore(resolve(PROJECT_ROOT, 'store', 'setup-link.json'))
const args = process.argv.slice(2)

function localClaude(): ClaudeSignIn {
  const bin = resolveBundledClaude(process.env, PROJECT_ROOT)
  let cached = { at: 0, value: false }
  return {
    available: !!bin,
    signedIn: () => {
      // `claude auth status` takes a moment; the page polls every 2s.
      if (Date.now() - cached.at > 3000) cached = { at: Date.now(), value: checkClaudeAuth(bin, spawnClaude).loggedIn }
      return cached.value
    },
    start: () => {
      if (!bin) return
      const child = spawn(bin, ['auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    },
  }
}

function openBrowser(url: string): void {
  const [cmd, cmdArgs] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  execFile(cmd, cmdArgs, { windowsHide: true }, () => {})
}

/**
 * The double-click path: run this same script without --background as a
 * detached child, logging to logs/setup-web.log, and leave once it answers.
 */
async function background(): Promise<never> {
  const url = `http://localhost:${PORT}/setup`
  const code = await launchInBackground({
    alreadySetUp: () => existsSync(resolve(PROJECT_ROOT, '.env')),
    probe: () => probeSetupPort(fetch, PORT),
    startServer: () => {
      mkdirSync(resolve(PROJECT_ROOT, 'logs'), { recursive: true })
      const log = openSync(resolve(PROJECT_ROOT, 'logs', 'setup-web.log'), 'a')
      const rest = args.filter((a) => a !== '--background')
      const child = spawn(process.execPath, [process.argv[1]!, ...rest], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true,
      })
      let exited = false
      child.on('exit', () => (exited = true))
      child.unref()
      return { exited: () => exited }
    },
    openBrowser: () => openBrowser(url),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  })
  process.exit(code)
}

/** Hand the port to the assistant. */
function startAssistant(mode: SetupMode): void {
  if (mode === 'hosted') {
    // No sudo here: this process faces the internet. The marker is all it
    // does; root's havn-setup-done.path sees it and starts the assistant.
    writeFileSync(resolve(PROJECT_ROOT, SETUP_FINISHED_MARKER), new Date().toISOString())
    return
  }
  try {
    execFileSync(process.execPath, [resolve(PROJECT_ROOT, 'dist', 'scripts', 'service.js'), 'install'], { cwd: PROJECT_ROOT, stdio: 'inherit' })
  } catch (err) {
    console.error(`Setup is saved, but the assistant did not start: ${String(err)}`)
    console.error('Start it with: node dist/scripts/service.js install')
    process.exitCode = 1
  }
}

function main(): void {
  if (args.includes('--background')) {
    void background()
    return
  }
  const issueAt = args.indexOf('--issue-link')
  if (issueAt !== -1) {
    const host = args[issueAt + 1] ?? ''
    if (!isValidHostname(host)) {
      console.error('Usage: setup-web --issue-link HOSTNAME   (e.g. 5-161-197-79.sslip.io)')
      process.exit(1)
    }
    const token = issueLink(links, Date.now())
    console.log(`https://${host}/setup?token=${token}`)
    console.log('Valid for 48 hours, once. Send it to the client; anyone with it can set up this assistant.')
    return
  }

  const mode: SetupMode = args.includes('--hosted') ? 'hosted' : 'local'
  if (mode === 'hosted') {
    const verdict = checkLink(links, 'x', Date.now())
    if (verdict === 'none') {
      console.error('No setup link has been issued. Run: node dist/scripts/setup-web.js --issue-link HOSTNAME')
      process.exit(1)
    }
    if (verdict === 'done') {
      console.log('Setup is already done; nothing to serve.')
      return
    }
  }

  const page = (): string => readFileSync(resolve(PROJECT_ROOT, 'templates', 'web-setup', 'index.html'), 'utf-8')
  const server = createSetupServer({
    mode,
    projectRoot: PROJECT_ROOT,
    home: homedir(),
    fetch,
    vault: defaultVault(),
    links,
    now: Date.now,
    page,
    ...(mode === 'local' ? { claude: localClaude() } : {}),
    onFinished: () => {
      console.log('Setup finished. Starting the assistant.')
      server.close(() => {
        startAssistant(mode)
        process.exit()
      })
      // Idle keep-alive connections from the page would hold close() open.
      server.closeAllConnections()
    },
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Is the assistant already running? Setup is only for a new install.`)
    else console.error(String(err))
    process.exit(1)
  })
  // Always loopback: locally that keeps it on this machine, and on a hosted
  // box the edge proxies to it.
  server.listen(PORT, '127.0.0.1', () => {
    if (mode === 'local') {
      const url = `http://localhost:${PORT}/setup`
      console.log(`Setup is open at ${url}`)
      if (!args.includes('--no-open')) openBrowser(url)
    } else {
      console.log(`Serving the one-time setup link on 127.0.0.1:${PORT}.`)
    }
  })
}

main()
