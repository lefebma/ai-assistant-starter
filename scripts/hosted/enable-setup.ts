/**
 * Put the web setup page on a freshly provisioned hosted box and print the
 * one-time link to send the client (cards #211-#213). Replaces the SSH session
 * where the operator ran `npm run setup` for them.
 *
 * Run as root, once, after cloud-init has finished:
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-setup.js <hostname>   (as havn-admin)
 *
 * What it does:
 *   - refuses if the box is already set up (.env exists)
 *   - installs Caddy and writes an edge that exposes only /setup (TLS from Let's Encrypt)
 *   - opens ufw 80/tcp (ACME) and 443/tcp
 *   - installs and starts havn-setup.service (as havn, no sudo), which serves
 *     the page until the client finishes and then writes store/setup-finished
 *   - arms havn-setup-done.path (root), which on that marker retires the
 *     setup units and enables and starts havn.service
 *   - issues the link (48 hours, single use) and prints it
 *
 * To reissue an expired link later (as havn):
 *   node dist/scripts/setup-web.js --issue-link <hostname>
 *
 * Later, enable-teams rewrites the same Caddyfile for Teams, voice and
 * shortcuts; /setup is gone from it then, and it 404s at the app anyway.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ACCESS_LOG_PATH, buildCaddyfile, isValidHostname } from '../../src/deploy/teams-edge.js'
import {
  buildHandoffPath,
  buildHandoffService,
  buildSetupUnit,
  HANDOFF_PATH_UNIT,
  HANDOFF_SERVICE_UNIT,
  SETUP_FINISHED_MARKER,
  SETUP_UNIT_NAME,
  SETUP_UNIT_PATH,
} from '../../src/deploy/setup-edge.js'

const INSTALL_DIR = '/home/havn/havn'
const ENV = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' }

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit', env: ENV })
}

function installed(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function caddyVersion(): string | undefined {
  try {
    return execFileSync('caddy', ['version'], { encoding: 'utf-8', env: ENV }).trim()
  } catch {
    return undefined
  }
}

function main(): void {
  const hostname = process.argv[2] ?? ''
  if (process.getuid?.() !== 0) {
    console.error('Run as root: sudo, from the havn-admin login.')
    process.exit(1)
  }
  if (!isValidHostname(hostname)) {
    console.error('Usage: sudo node dist/scripts/hosted/enable-setup.js <hostname>   (e.g. 5-161-197-79.sslip.io)')
    process.exit(1)
  }
  if (existsSync(`${INSTALL_DIR}/.env`)) {
    console.error('This box is already set up (.env exists). Web setup is only for a new box.')
    process.exit(1)
  }

  if (!installed('caddy')) {
    run('apt-get', ['update', '-q'])
    run('apt-get', ['install', '-y', 'caddy'])
  }
  mkdirSync(dirname(ACCESS_LOG_PATH), { recursive: true })
  try {
    run('chown', ['caddy:caddy', dirname(ACCESS_LOG_PATH)])
  } catch {
    // No caddy user (unusual install); Caddy will report the real problem.
  }
  writeFileSync(
    '/etc/caddy/Caddyfile',
    buildCaddyfile(hostname, { teams: false, shortcuts: false, voice: false, setup: true, caddyVersion: caddyVersion() })
  )
  run('caddy', ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
  run('ufw', ['allow', '80/tcp'])
  run('ufw', ['allow', '443/tcp'])
  run('systemctl', ['enable', '--now', 'caddy'])
  try {
    run('systemctl', ['reload', 'caddy'])
  } catch {
    run('systemctl', ['restart', 'caddy'])
  }

  mkdirSync(`${INSTALL_DIR}/logs`, { recursive: true })
  run('chown', ['havn:havn', `${INSTALL_DIR}/logs`])
  writeFileSync(SETUP_UNIT_PATH, buildSetupUnit(INSTALL_DIR))
  writeFileSync(`/etc/systemd/system/${HANDOFF_PATH_UNIT}`, buildHandoffPath(INSTALL_DIR))
  writeFileSync(`/etc/systemd/system/${HANDOFF_SERVICE_UNIT}`, buildHandoffService())
  run('systemctl', ['daemon-reload'])
  // A marker left from an earlier attempt would fire the handoff at once.
  rmSync(`${INSTALL_DIR}/${SETUP_FINISHED_MARKER}`, { force: true })
  // Armed before the setup page goes up, so a finish can never be missed.
  run('systemctl', ['enable', '--now', HANDOFF_PATH_UNIT])

  // Issued as havn, so the link file belongs to the user the setup server runs as.
  const out = execFileSync('runuser', ['-u', 'havn', '--', '/usr/bin/node', `${INSTALL_DIR}/dist/scripts/setup-web.js`, '--issue-link', hostname], {
    encoding: 'utf-8',
    cwd: INSTALL_DIR,
  })
  run('systemctl', ['enable', '--now', SETUP_UNIT_NAME])

  console.log('\nWeb setup is live. Send the client this link:\n')
  console.log(`  ${out.trim().split('\n')[0]}\n`)
  console.log('It works once and expires in 48 hours. Caddy gets its certificate on the first visit; give it a minute.')
  console.log(`Reissue later (as havn): node ${INSTALL_DIR}/dist/scripts/setup-web.js --issue-link ${hostname}`)
}

main()
