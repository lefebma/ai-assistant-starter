/**
 * Pure pieces of the hosted-box Teams edge: the Caddyfile that proxies only
 * the webhook path to the app, and the hostname checks around it.
 * scripts/hosted/enable-teams.ts does the apt/ufw/systemctl work.
 */
export const TEAMS_WEBHOOK_PREFIX = '/api/teams/*'
export const APP_UPSTREAM = '127.0.0.1:3030'

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function isValidHostname(hostname: string): boolean {
  return HOSTNAME.test(hostname)
}

/** 5.161.197.79 -> 5-161-197-79.sslip.io (sslip.io resolves that to the IP; no DNS to manage). */
export function sslipHostname(ip: string): string {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Not an IPv4 address: ${ip}`)
  return `${ip.replace(/\./g, '-')}.sslip.io`
}

export function buildCaddyfile(hostname: string): string {
  if (!isValidHostname(hostname)) throw new Error(`Not a valid hostname: ${hostname}`)
  return [
    '# Havn: Teams webhook only. Written by scripts/hosted/enable-teams.ts.',
    `${hostname} {`,
    `\thandle ${TEAMS_WEBHOOK_PREFIX} {`,
    `\t\treverse_proxy ${APP_UPSTREAM}`,
    '\t}',
    '\thandle {',
    '\t\trespond 404',
    '\t}',
    '}',
    '',
  ].join('\n')
}
