/**
 * One-command hosted provisioning on Vultr (card #214).
 *
 * Replaces the hand-run sequence from docs/HOSTED-VPS.md: render user-data,
 * create the server, turn on daily backups, point <client>.gethavn.ai at it,
 * wait for first boot to finish, run enable-setup, and hand back the one-time
 * setup link for the operator to email the client.
 *
 * Everything that talks to the outside world comes in through ProvisionDeps,
 * so the whole flow runs against fakes in tests. scripts/hosted/provision.ts
 * is the CLI shell that wires real fetch, ssh and secrets from the
 * environment.
 *
 * Nothing here deletes a server. If a step fails after the server exists, the
 * error says which server it is so the operator can look before cleaning up.
 */

import { DEFAULT_INSTALL_DIR, renderCloudInit, type ClientSpec } from './cloud-init.js'

export type Country = 'us' | 'ca'

/** Clients in the US go to New Jersey, Canadian clients stay in Toronto. */
export const VULTR_REGIONS: Record<Country, string> = { us: 'ewr', ca: 'yto' }
/** 1 vCPU / 2 GB, about $10 a month plus 20% for backups (havn-leif's plan). */
export const VULTR_PLAN = 'vc2-1c-2gb'
/** Ubuntu 24.04 LTS x64. */
export const VULTR_OS_ID = 2284
export const BACKUP_HOUR_UTC = 7
export const DEFAULT_DOMAIN = 'gethavn.ai'

const VULTR_API = 'https://api.vultr.com/v2'
const CF_API = 'https://api.cloudflare.com/client/v4'

/** Subdomains the site, mail or future product surfaces already use or will. */
export const RESERVED_NAMES = new Set([
  'www', 'staging', 'voice', 'app', 'api', 'mail', 'smtp', 'setup', 'admin', 'docs', 'status',
  'blog', 'help', 'support', 'billing', 'legal', 'privacy', 'security', 'sales', 'hello',
  'dashboard', 'portal', 'login', 'auth', 'account', 'test', 'dev', 'cdn', 'static',
])

/** One DNS label; also becomes the hostname havn-<client>. */
const CLIENT_RE = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/

export interface ProvisionSpec {
  /** Short client name, e.g. 'leif'. Host havn-leif, address leif.gethavn.ai. */
  client: string
  country: Country
  timezone: string
  sshPublicKey: string
  gitRef?: string
  domain?: string
}

export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

export type SshUser = 'havn' | 'havn-admin'

export interface ProvisionDeps {
  fetch: typeof fetch
  vultrApiKey: string
  cloudflareToken: string
  cloudflareZoneId: string
  /** `user` defaults to havn; root steps log in as havn-admin (card #196). */
  ssh: (host: string, command: string, user?: SshUser) => Promise<SshResult>
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (message: string) => void
  templates: { cloudInit: string; unit: string }
  /**
   * Give the box its own maps proxy token (card #266), stored in its vault.
   * Set when the operator has the proxy configured; a failure here leaves
   * travel times off but does not stop provisioning.
   */
  connectMaps?: (box: string, host: string) => Promise<void>
}

export interface ProvisionResult {
  instanceId: string
  hostName: string
  ip: string
  region: string
  address: string
  link: string
}

export function hostNameFor(client: string): string {
  return `havn-${client}`
}

export function addressFor(client: string, domain = DEFAULT_DOMAIN): string {
  return `${client}.${domain}`
}

export function validateProvisionSpec(spec: ProvisionSpec): string[] {
  const problems: string[] = []
  const client = spec.client?.trim() ?? ''
  if (!CLIENT_RE.test(client)) {
    problems.push('client must be lowercase letters, digits and dashes (e.g. leif or smith-law), up to 42 characters')
  } else if (RESERVED_NAMES.has(client)) {
    problems.push(`client name "${client}" is reserved for the site; pick another`)
  }
  if (spec.country !== 'us' && spec.country !== 'ca') problems.push('country must be us or ca')
  return problems
}

/** User-data for the box: the standard template, hostname havn-<client>. */
export function buildUserData(spec: ProvisionSpec, templates: { cloudInit: string; unit: string }): string {
  const client: ClientSpec = {
    hostName: hostNameFor(spec.client),
    timezone: spec.timezone,
    sshPublicKey: spec.sshPublicKey,
    gitRef: spec.gitRef,
  }
  return renderCloudInit(templates.cloudInit, templates.unit, client)
}

/** Pull the link enable-setup printed, and only one for this address. */
export function extractSetupLink(output: string, address: string): string | null {
  const escaped = address.replace(/\./g, '\\.')
  const m = output.match(new RegExp(`https://${escaped}/setup\\?token=[A-Za-z0-9_-]{20,}`))
  return m ? m[0] : null
}

/** The note the operator sends. Plain words; the client is not technical. */
export function clientEmail(opts: { clientName: string; link: string }): string {
  const greeting = opts.clientName.trim() ? `Hi ${opts.clientName.trim()},` : 'Hi,'
  return [
    'Subject: Your Havn assistant is ready to set up',
    '',
    greeting,
    '',
    'Your Havn assistant is ready. Setting it up takes about five minutes:',
    '',
    `  ${opts.link}`,
    '',
    'Before you start, install Telegram on your phone and sign in. The page walks you',
    'through the rest: your name and city, creating your bot, and a final tap to finish.',
    '',
    'The link works once and expires in 48 hours. If it runs out, reply to this email',
    'and we will send a fresh one.',
    '',
  ].join('\n')
}

class StepError extends Error {}

async function vultr(deps: ProvisionDeps, method: string, path: string, body?: unknown): Promise<any> {
  const res = await deps.fetch(`${VULTR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${deps.vultrApiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new StepError(`Vultr ${method} ${path} failed (${res.status}): ${vultrError(text)}`)
  return text ? JSON.parse(text) : {}
}

function vultrError(text: string): string {
  try {
    return JSON.parse(text).error || text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

async function cloudflare(deps: ProvisionDeps, method: string, path: string, body?: unknown): Promise<any> {
  const res = await deps.fetch(`${CF_API}/zones/${deps.cloudflareZoneId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${deps.cloudflareToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[]; result?: unknown }
  if (!res.ok || json.success === false) {
    const why = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new StepError(`Cloudflare ${method} ${path} failed: ${why}`)
  }
  return json
}

async function waitFor<T>(
  deps: ProvisionDeps,
  what: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | null>
): Promise<T> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v !== null) return v
    if (deps.now() >= deadline) throw new StepError(`timed out waiting for ${what}`)
    await deps.sleep(intervalMs)
  }
}

/**
 * Refuse before spending money: the name must be free on both Vultr and DNS.
 * Exported for the CLI's --dry-run.
 */
export async function preflight(spec: ProvisionSpec, deps: ProvisionDeps): Promise<void> {
  const problems = validateProvisionSpec(spec)
  if (problems.length) throw new StepError(problems.join('\n'))
  const hostName = hostNameFor(spec.client)
  const address = addressFor(spec.client, spec.domain)
  const existing = await vultr(deps, 'GET', `/instances?label=${encodeURIComponent(hostName)}`)
  if ((existing.instances ?? []).length > 0) {
    throw new StepError(`a Vultr server labelled ${hostName} already exists (${existing.instances[0].main_ip})`)
  }
  const dns = await cloudflare(deps, 'GET', `/dns_records?name=${encodeURIComponent(address)}`)
  if ((dns.result ?? []).length > 0) throw new StepError(`${address} already has a DNS record`)
}

export async function provision(spec: ProvisionSpec, deps: ProvisionDeps): Promise<ProvisionResult> {
  const hostName = hostNameFor(spec.client)
  const address = addressFor(spec.client, spec.domain)
  const region = VULTR_REGIONS[spec.country]

  // Render first: a template or key problem must stop us before any spend.
  const userData = buildUserData(spec, deps.templates)
  await preflight(spec, deps)

  deps.log(`Creating ${hostName} in ${region} (${VULTR_PLAN}, Ubuntu 24.04, backups on)...`)
  const created = await vultr(deps, 'POST', '/instances', {
    region,
    plan: VULTR_PLAN,
    os_id: VULTR_OS_ID,
    label: hostName,
    hostname: hostName,
    user_data: Buffer.from(userData, 'utf-8').toString('base64'),
    backups: 'enabled',
    tags: ['havn'],
  })
  const instanceId: string = created.instance?.id
  if (!instanceId) throw new StepError('Vultr did not return an instance id')

  try {
    const ip = await waitFor(deps, `${hostName} to get an address`, 10 * 60_000, 15_000, async () => {
      const got = await vultr(deps, 'GET', `/instances/${instanceId}`)
      const i = got.instance ?? {}
      return i.status === 'active' && i.main_ip && i.main_ip !== '0.0.0.0' ? (i.main_ip as string) : null
    })
    deps.log(`Server is up at ${ip}.`)

    // The API default is weekly; havn-leif runs daily at 07:00 UTC.
    await vultr(deps, 'POST', `/instances/${instanceId}/backup-schedule`, { type: 'daily', hour: BACKUP_HOUR_UTC })
    deps.log(`Backups: daily at ${String(BACKUP_HOUR_UTC).padStart(2, '0')}:00 UTC.`)

    // DNS only, never proxied: Caddy on the box answers the ACME challenge itself.
    await cloudflare(deps, 'POST', '/dns_records', {
      type: 'A',
      name: address,
      content: ip,
      ttl: 300,
      proxied: false,
      comment: `Havn client box ${hostName} (Vultr ${instanceId})`,
    })
    deps.log(`DNS: ${address} -> ${ip}.`)

    deps.log('Waiting for first boot to finish installing (usually 4 to 8 minutes)...')
    await waitFor(deps, `${hostName} to finish installing`, 30 * 60_000, 20_000, async () => {
      const r = await deps.ssh(ip, 'cloud-init status 2>/dev/null; test -f /var/lib/havn/provisioned && echo HAVN_READY')
      if (r.code === 255) return null // ssh not reachable yet
      if (/status: error/.test(r.stdout)) {
        throw new StepError(`first boot failed on ${hostName}; see /var/log/havn-provision.log on the box`)
      }
      if (/status: done/.test(r.stdout)) {
        if (!r.stdout.includes('HAVN_READY')) {
          throw new StepError(`first boot finished but ${hostName} is not marked provisioned; see /var/log/havn-provision.log`)
        }
        return true
      }
      return null
    })
    deps.log('Install finished.')

    if (deps.connectMaps) {
      try {
        await deps.connectMaps(hostName, ip)
        deps.log(`Maps: ${hostName} has its own maps proxy token.`)
      } catch (err) {
        deps.log(`Maps: not connected (${err instanceof Error ? err.message : String(err)}). ` +
          `Travel times stay off until you run: npm run maps-token -- issue ${hostName} ${ip}`)
      }
    } else {
      deps.log('Maps: HAVN_MAPS_URL not set, so travel times are off on this box for now.')
    }

    deps.log(`Turning on web setup at https://${address}/setup ...`)
    const installDir = DEFAULT_INSTALL_DIR
    // havn has no general sudo; root steps go through the admin login. That
    // login cannot enter /home/havn (mode 750), so the cd runs as root too.
    const r = await deps.ssh(
      ip,
      `sudo sh -c 'cd ${installDir} && node dist/scripts/hosted/enable-setup.js ${address}'`,
      'havn-admin',
    )
    const link = r.code === 0 ? extractSetupLink(r.stdout, address) : null
    if (!link) {
      const tail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')
      throw new StepError(`enable-setup did not produce a link (exit ${r.code}):\n${tail}`)
    }

    return { instanceId, hostName, ip, region, address, link }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${why}\n\nThe server exists and is billing: ${hostName}, Vultr instance ${instanceId}. ` +
        'Look at it before deleting it (Vultr dashboard, or DELETE /v2/instances/<id>), ' +
        `and remove the ${address} DNS record if one was created.`
    )
  }
}
