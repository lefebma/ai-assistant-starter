/**
 * Service CLI (Phase 5): install / uninstall / start / stop / status / logs
 * behind one command, on every platform.
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
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_ROOT, readEnvFile } from '../src/env.js'
import { resolveServiceManager } from '../src/service/index.js'

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
})

const DRY_RUN = process.argv.includes('--dry-run')
const cmd = process.argv[2]

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
      console.log('usage: service <install|uninstall|start|stop|status|logs> [--dry-run]')
      process.exit(cmd ? 1 : 0)
  }
}

main().catch((err) => {
  console.error(String(err))
  process.exit(1)
})
