/**
 * Expose the Teams webhook on a hosted Havn box.
 *
 * Run as root, once, after cloud-init has finished and the app is built:
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js 5-161-197-79.sslip.io
 *
 * What it does, and nothing else:
 *   - installs Caddy (Ubuntu 24.04 universe) for automatic Let's Encrypt TLS
 *   - proxies ONLY https://<hostname>/api/teams/* to the app on 127.0.0.1:3030;
 *     every other path answers 404, so the cockpit/voice surfaces stay private
 *   - opens ufw 80/tcp (ACME HTTP-01 challenge) and 443/tcp; 3030 stays closed
 *   - prints the messaging endpoint to paste into the Azure Bot registration
 *
 * sslip.io turns an IP into a resolvable name (1-2-3-4.sslip.io) so there is no
 * DNS to manage; an owned subdomain works the same way. Every command runs via
 * execFileSync with an argument array: no shell, nothing interpolated.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buildCaddyfile, isValidHostname } from '../../src/deploy/teams-edge.js'

const USAGE = 'Usage: sudo node dist/scripts/hosted/enable-teams.js <hostname>   (e.g. 5-161-197-79.sslip.io)'
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

function main(): void {
  const hostname = process.argv[2]
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

  writeFileSync('/etc/caddy/Caddyfile', buildCaddyfile(hostname))
  run('caddy', ['validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])

  run('ufw', ['allow', '80/tcp'])
  run('ufw', ['allow', '443/tcp'])

  run('systemctl', ['enable', '--now', 'caddy'])
  try {
    run('systemctl', ['reload', 'caddy'])
  } catch {
    run('systemctl', ['restart', 'caddy'])
  }

  console.log('Teams webhook exposed.')
  console.log(`  Messaging endpoint: https://${hostname}/api/teams/messages`)
  console.log('  Caddy obtains the certificate on first request; give it a minute.')
  console.log(`  Check: curl -si https://${hostname}/api/teams/messages -X POST | head -1   (expect 401 from the app; 404 on any other path)`)
}

main()
