/**
 * Expose the Teams webhook (and optionally the voice UI) on a hosted Havn box.
 *
 * Run as root, once, after cloud-init has finished and the app is built:
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname>
 *   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname> --voice
 *
 * --voice reads HTTP_BEARER_TOKEN from /home/havn/havn/.env and uses it as the
 * token-in-URL for the voice page. The same token is used for API bearer auth.
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
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildCaddyfile, isValidHostname } from '../../src/deploy/teams-edge.js'

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

/** Read HTTP_BEARER_TOKEN from the app .env file */
function readBearerToken(): string {
  try {
    const envPath = resolve('/home/havn/havn/.env')
    const content = readFileSync(envPath, 'utf-8')
    const match = content.match(/^HTTP_BEARER_TOKEN=(.+)$/m)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
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

  let voiceToken: string | undefined
  if (enableVoice) {
    voiceToken = readBearerToken()
    if (!voiceToken) {
      console.error('--voice requires HTTP_BEARER_TOKEN in /home/havn/havn/.env')
      process.exit(1)
    }
  }

  if (!installed('caddy')) {
    run('apt-get', ['update', '-q'])
    run('apt-get', ['install', '-y', 'caddy'])
  }

  writeFileSync('/etc/caddy/Caddyfile', buildCaddyfile(hostname, { teams: true, voiceToken }))
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
  if (voiceToken) {
    console.log(`  Voice UI:       https://${hostname}/voice?token=${voiceToken}`)
  }
  console.log('  Caddy obtains the certificate on first request; give it a minute.')
  console.log(`  Check: curl -si https://${hostname}/api/teams/messages -X POST | head -1`)
}

main()
