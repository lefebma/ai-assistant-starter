/**
 * Pure pieces of the hosted-box edge: the Caddyfile that proxies the webhook
 * and (optionally) the voice UI to the app, hostname checks around it.
 * scripts/hosted/enable-teams.ts does the apt/ufw/systemctl work.
 */
export const TEAMS_WEBHOOK_PREFIX = '/api/teams/*'
export const APP_UPSTREAM = '127.0.0.1:3030'
export const ACCESS_LOG_PATH = '/var/log/caddy/access.log'

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function isValidHostname(hostname: string): boolean {
  return HOSTNAME.test(hostname)
}

/** 5.161.197.79 -> 5-161-197-79.sslip.io (sslip.io resolves that to the IP; no DNS to manage). */
export function sslipHostname(ip: string): string {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Not an IPv4 address: ${ip}`)
  return `${ip.replace(/\./g, '-')}.sslip.io`
}

export interface CaddyfileOptions {
  /** Enable /api/teams/* webhook proxy (default: true) */
  teams?: boolean
  /**
   * Expose the voice UI. The edge does not hold the credential: it proxies
   * /voice and the app validates the per-chat link token (src/voice-links.ts).
   * Embedding a token here made every Caddyfile a copy of the box-wide secret
   * and meant rotating it required a redeploy.
   */
  voice?: boolean
}

export function buildCaddyfile(hostname: string, options?: CaddyfileOptions): string {
  if (!isValidHostname(hostname)) throw new Error(`Not a valid hostname: ${hostname}`)

  const teams = options?.teams !== false
  const voice = options?.voice === true

  const lines: string[] = [
    `# Havn edge config. Written by scripts/hosted/enable-teams.ts.`,
    `${hostname} {`,
    '',
    // Two redactions are load-bearing, not hygiene. A voice link carries its
    // credential in the query string, and the page sends the same value as a
    // bearer header on every API call, so an unfiltered access log would write
    // working credentials to disk in two places at once. Client addresses are
    // masked to the network: enough to tell a datacentre crawler from a person,
    // not enough to track one.
    '\tlog {',
    `\t\toutput file ${ACCESS_LOG_PATH} {`,
    '\t\t\troll_size 10MiB',
    '\t\t\troll_keep 5',
    '\t\t\troll_keep_for 720h',
    '\t\t}',
    '\t\tformat filter {',
    '\t\t\twrap json',
    '\t\t\tfields {',
    '\t\t\t\trequest>uri query {',
    '\t\t\t\t\treplace token REDACTED',
    '\t\t\t\t}',
    '\t\t\t\trequest>remote_ip ip_mask {',
    '\t\t\t\t\tipv4 24',
    '\t\t\t\t\tipv6 48',
    '\t\t\t\t}',
    '\t\t\t\trequest>headers>Authorization delete',
    '\t\t\t\trequest>headers>Cookie delete',
    '\t\t\t}',
    '\t\t}',
    '\t}',
  ]

  // Teams webhook: no auth (adapter handles its own verification)
  if (teams) {
    lines.push(
      '',
      `\t# Teams webhook (adapter handles verification)`,
      `\thandle ${TEAMS_WEBHOOK_PREFIX} {`,
      `\t\treverse_proxy ${APP_UPSTREAM} {`,
      '\t\t\t# Hold the request while the app restarts rather than 502ing it.',
      '\t\t\t# Teams pushes each message exactly once: a 502 is not a retry',
      '\t\t\t# later, it is that message gone. Telegram is forgiving here',
      '\t\t\t# because it polls and holds anything sent while the bot is away.',
      '\t\t\t# 15s because the Bot Framework stops waiting around there, so a',
      '\t\t\t# longer hold would just fail more slowly.',
      '\t\t\tlb_try_duration 15s',
      '\t\t\tlb_try_interval 500ms',
      '\t\t}',
      '\t}',
    )
  }

  // Voice UI. The app checks the link token on /voice and the bearer on the
  // API routes, so nothing secret lives in this file.
  if (voice) {
    lines.push(
      '',
      '\t# Voice UI page. The app validates ?token= and 403s a bad or expired link.',
      '\t@voice_page {',
      '\t\tpath /voice /voice/',
      '\t}',
      '\thandle @voice_page {',
      `\t\treverse_proxy ${APP_UPSTREAM}`,
      '\t}',
      '',
      '\t# Static assets for voice UI (JS libs, worklet)',
      '\t@static_assets {',
      '\t\tpath /*.js /*.css /*.svg',
      '\t}',
      '\thandle @static_assets {',
      `\t\treverse_proxy ${APP_UPSTREAM}`,
      '\t}',
      '',
      '\t# API endpoints (chat completions, transcribe, speak, signed-url, config)',
      '\t@api {',
      '\t\tpath /v1/* /chat/* /api/signed-url /api/config /api/transcribe /api/speak',
      '\t}',
      '\thandle @api {',
      `\t\treverse_proxy ${APP_UPSTREAM}`,
      '\t}',
    )
  }

  // Catch-all
  lines.push(
    '',
    '\t# Everything else: 404',
    '\thandle {',
    '\t\trespond 404',
    '\t}',
    '}',
    '',
  )

  return lines.join('\n')
}
