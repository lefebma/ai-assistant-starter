/**
 * Service CLI (Phase 5): install / uninstall / start / stop / restart /
 * status / logs behind one command, on every platform.
 *
 * `install` also drops a double-clickable restart launcher (see
 * src/service/launcher.ts) so recovery never requires a terminal.
 *
 *   macOS:   launchd LaunchAgent (auto-start at login, restart on crash)
 *   Linux:   systemd user unit (enable --now, Restart=on-failure)
 *   Windows: Task Scheduler logon task — baseline until the installer ships
 *            a full SCM service; no crash-restart supervision yet.
 *
 * Usage (run compiled): node dist/scripts/service.js <command> [--dry-run]
 *   install --dry-run prints the artifact (plist/unit/schtasks command)
 *   without touching the system.
 *
 * Config (.env): SERVICE_NAME (default ai-assistant), SERVICE_LABEL
 * (default com.<name>.service).
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, readEnvFile } from '../src/env.js'
import { resolveServiceManager } from '../src/service/index.js'
import { launcherFiles, resolveAppName, APP_NAME_FILE } from '../src/service/launcher.js'

const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>
const name = env.SERVICE_NAME ?? 'ai-assistant'
const label = env.SERVICE_LABEL ?? `com.${name}.service`
const logFile = resolve(PROJECT_ROOT, 'logs', 'service.log')

const manager = resolveServiceManager(process.platform, {
  label,
  name,
  nodePath: process.execPath,
  entry: resolve(PROJECT_ROOT, 'dist', 'src', 'index.js'),
  cwd: PROJECT_ROOT,
  logFile,
  winswExe: env.WINSW_PATH ?? resolve(PROJECT_ROOT, 'tools', 'winsw', `${name}-service.exe`),
})

const DRY_RUN = process.argv.includes('--dry-run')
const cmd = process.argv[2]

/**
 * Drop the double-clickable restart launcher next to the user's other apps.
 * ~/Applications rather than /Applications: no admin prompt, and Spotlight
 * indexes it either way. Never fatal — a missing launcher must not fail an
 * otherwise good service install.
 */
function installLauncher(): void {
  try {
    const root = process.platform === 'darwin' ? resolve(homedir(), 'Applications') : PROJECT_ROOT
    const stampPath = resolve(PROJECT_ROOT, APP_NAME_FILE)
    const files = launcherFiles(process.platform, {
      // The build stamps the product name into the payload; without reading it
      // a Havn install ends up with "Setup Havn.command" beside
      // "Restart AI Assistant.app".
      appName: resolveAppName(env.APP_NAME, existsSync(stampPath) ? readFileSync(stampPath, 'utf-8') : undefined),
      nodePath: process.execPath,
      cwd: PROJECT_ROOT,
    })
    for (const f of files) {
      const dest = resolve(root, f.path)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.content, f.executable ? { mode: 0o755 } : undefined)
    }
    console.log(`Restart shortcut installed: ${resolve(root, files[0].path.split('/')[0])}`)
  } catch (err) {
    console.log(`Note: could not create the restart shortcut (${err instanceof Error ? err.message : String(err)}).`)
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'install': {
      if (!existsSync(resolve(PROJECT_ROOT, 'dist', 'src', 'index.js'))) {
        console.error('dist/src/index.js missing - run npm run build first')
        process.exit(1)
      }
      if (DRY_RUN) {
        console.log(`[dry-run] would install ${manager.kind} service '${name}'`)
        const path = manager.artifactPath()
        if (path) console.log(`[dry-run] artifact: ${path}`)
        console.log(manager.renderArtifact())
        return
      }
      await manager.install()
      console.log(`Installed ${manager.kind} service '${name}'. Status: ${await manager.status()}`)
      if (manager.kind === 'schtasks') {
        console.log('Note: Task Scheduler tasks do not restart on crash; the installer release upgrades this to a full Windows service.')
      }
      installLauncher()
      break
    }
    case 'uninstall':
      await manager.uninstall()
      console.log(`Uninstalled ${manager.kind} service '${name}'.`)
      break
    case 'start':
      await manager.start()
      console.log(`Start requested. Status: ${await manager.status()}`)
      break
    case 'restart':
      // stop/start rather than a per-manager restart: launchd, systemd,
      // schtasks and winsw all support these two, and a wedged-but-alive
      // process is exactly what needs the stop half.
      await manager.stop()
      await manager.start()
      console.log(`Restart requested. Status: ${await manager.status()}`)
      break
    case 'stop':
      await manager.stop()
      console.log(`Stop requested. Status: ${await manager.status()}`)
      break
    case 'status':
      console.log(`${name} (${manager.kind}): ${await manager.status()}`)
      break
    case 'logs': {
      console.log(`log file: ${logFile}\n`)
      if (existsSync(logFile)) {
        const lines = readFileSync(logFile, 'utf-8').split('\n')
        console.log(lines.slice(-50).join('\n'))
      } else {
        console.log('(no log file yet)')
      }
      break
    }
    default:
      console.log('usage: service <install|uninstall|start|stop|restart|status|logs> [--dry-run]')
      process.exit(cmd ? 1 : 0)
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
