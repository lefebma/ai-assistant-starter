/**
 * Expose the Teams webhook (and optionally the voice UI) on a hosted Havn box.
 *
 * Run as root, once, after cloud-init has finished and the app is built:
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname>
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname> --voice
 *
 * --voice exposes the voice UI and records PUBLIC_HOSTNAME in .env so the
 * assistant can build links for it. The page is not gated by a shared secret in
 * this config: each user mints their own expiring link with `/voice ui` in
 * chat, and the app validates it (src/voice-links.ts).
 *
 * What it does:
 *   - installs Caddy (Ubuntu 24.04 universe) for automatic Let's Encrypt TLS
 *   - proxies https://<hostname>/api/teams/* to the app on 127.0.0.1:3030
 *   - with --voice: exposes /voice (token-gated), static assets, and API routes
 *   - opens ufw 80/tcp (ACME HTTP-01 challenge) and 443/tcp; 3030 stays closed
 *   - prints endpoints to configure
 *
 * sslip.io turns an IP into a resolvable name (1-2-3-4.sslip.io) so there is no
 * DNS to manage; an owned subdomain works the same way. Every command runs via
 * execFileSync with an argument array: no shell, nothing interpolated.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { ACCESS_LOG_PATH, buildCaddyfile, isValidHostname } from '../../src/deploy/teams-edge.js'

const USAGE = 'Usage: sudo node dist/scripts/hosted/enable-teams.js <hostname> [--voice]   (e.g. 5-161-197-79.sslip.io)'
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

const ENV_PATH = '/home/havn/havn/.env'

/**
 * Record the edge hostname so `/voice ui` can build links. Rewrites the value
 * in place if the key already exists (re-running with a new hostname should
 * move the links, not leave two lines fighting).
 */
function writePublicHostname(hostname: string): void {
  const envPath = resolve(ENV_PATH)
  let content = ''
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    console.error(`Cannot read ${ENV_PATH}; is the app installed?`)
    process.exit(1)
  }
  const line = `PUBLIC_HOSTNAME=${hostname}`
  const updated = /^PUBLIC_HOSTNAME=.*$/m.test(content)
    ? content.replace(/^PUBLIC_HOSTNAME=.*$/m, line)
    : content.replace(/\n*$/, `\n${line}\n`)
  // Truncating an existing file keeps its owner and mode; .env stays havn-owned.
  writeFileSync(envPath, updated)
}

function main(): void {
  const args = process.argv.slice(2)
  const hostname = args.find(a => !a.startsWith('--'))
  const enableVoice = args.includes('--voice')

  if (!hostname) {
    console.error(USAGE)
    process.exit(1)
  }
  if (process.getuid?.() !== 0) {
    console.error('Run as root (sudo).')
    process.exit(1)
  }
  if (!isValidHostname(hostname)) {
    console.error(`Not a valid hostname: ${hostname}`)
    process.exit(1)
  }

  if (!installed('caddy')) {
    run('apt-get', ['update', '-q'])
    run('apt-get', ['install', '-y', 'caddy'])
  }

  if (enableVoice) writePublicHostname(hostname)

  // The apt package creates this, but a box where Caddy was installed another
  // way would otherwise fail to start on a log path it cannot write.
  mkdirSync(dirname(ACCESS_LOG_PATH), { recursive: true })
  try {
    run('chown', ['caddy:caddy', dirname(ACCESS_LOG_PATH)])
  } catch {
    // No caddy user (unusual install); Caddy will report the real problem.
  }

  writeFileSync('/etc/caddy/Caddyfile', buildCaddyfile(hostname, { teams: true, voice: enableVoice }))
  run('caddy', ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])

  run('ufw', ['allow', '80/tcp'])
  run('ufw', ['allow', '443/tcp'])

  run('systemctl', ['enable', '--now', 'caddy'])
  try {
    run('systemctl', ['reload', 'caddy'])
  } catch {
    run('systemctl', ['restart', 'caddy'])
  }

  console.log('Edge configured.')
  console.log(`  Teams endpoint: https://${hostname}/api/teams/messages`)
  if (enableVoice) {
    console.log(`  Voice UI:       https://${hostname}/voice`)
    console.log('                  Users get their own link by sending /voice ui in chat.')
    console.log('                  Restart the service so it picks up PUBLIC_HOSTNAME:')
    console.log('                    sudo systemctl restart havn')
  }
  console.log('  Caddy obtains the certificate on first request; give it a minute.')
  console.log(`  Check: curl -si https://${hostname}/api/teams/messages -X POST | head -1`)
}

main()
