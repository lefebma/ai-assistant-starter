/**
 * Provision a hosted Havn box on Vultr in one command (card #214).
 *
 *   npm run provision -- --client leif --country us --ssh-key ~/.ssh/id_ed25519.pub \
 *     [--name "Leif"] [--timezone America/New_York] [--ref main] [--dry-run]
 *
 * Creates havn-<client> (New Jersey for us, Toronto for ca) with daily
 * backups, points <client>.gethavn.ai at it, waits for first boot, turns on
 * the web setup and prints the one-time link plus an email to send the client.
 *
 * Secrets come from the environment only, never argv:
 *   VULTR_API_KEY          Vultr API key
 *   CLOUDFLARE_API_TOKEN   DNS:Edit on the gethavn.ai zone
 *   CLOUDFLARE_ZONE_ID     that zone's id
 *
 * --dry-run checks the inputs, renders the user-data and confirms the name is
 * free on Vultr and in DNS, without creating anything.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT } from '../../src/env.js'
import {
  addressFor,
  buildUserData,
  clientEmail,
  DEFAULT_DOMAIN,
  hostNameFor,
  preflight,
  provision,
  type Country,
  type ProvisionDeps,
  type ProvisionSpec,
  type SshResult,
} from '../../src/deploy/provision.js'
import { resolveSshKey } from '../make-cloud-init.js'

const USAGE = `Usage: npm run provision -- --client <name> --country <us|ca> --ssh-key <key-or-.pub-path> [options]

  --client <name>     Short client name: host havn-<name>, address <name>.${DEFAULT_DOMAIN}
  --country <us|ca>   us: New Jersey (ewr). ca: Toronto (yto).
  --ssh-key <value>   Your SSH public key line, or the path to the .pub file
  --name <text>       Client's first name for the email greeting
  --timezone <tz>     IANA timezone (default America/New_York for us, America/Toronto for ca)
  --ref <ref>         Branch or tag to deploy (default main)
  --dry-run           Check everything, create nothing

Environment: VULTR_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID`

const DEFAULT_TZ: Record<Country, string> = { us: 'America/New_York', ca: 'America/Toronto' }

interface Cli {
  spec: ProvisionSpec
  name: string
  dryRun: boolean
}

export function parseProvisionArgs(argv: string[]): Cli {
  const o: Record<string, string> = {}
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run') dryRun = true
    else if (a === '--help' || a === '-h') throw new Error(USAGE)
    else if (['--client', '--country', '--ssh-key', '--name', '--timezone', '--ref'].includes(a)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n\n${USAGE}`)
      o[a.slice(2)] = v
    } else throw new Error(`Unknown option ${a}\n\n${USAGE}`)
  }
  for (const req of ['client', 'country', 'ssh-key']) {
    if (!o[req]) throw new Error(`--${req} is required\n\n${USAGE}`)
  }
  const country = o['country']!.toLowerCase() as Country
  return {
    spec: {
      client: o['client']!.trim().toLowerCase(),
      country,
      timezone: o['timezone'] ?? DEFAULT_TZ[country] ?? '',
      sshPublicKey: resolveSshKey(o['ssh-key']!, (p) => readFileSync(p, 'utf-8'), existsSync),
      gitRef: o['ref'],
    },
    name: o['name'] ?? '',
    dryRun,
  }
}

/** ssh as havn; a fresh box on a recycled IP must not trip an old host key. */
function makeSsh(): (host: string, command: string) => Promise<SshResult> {
  const cleared = new Set<string>()
  return (host, command) => {
    if (!cleared.has(host)) {
      cleared.add(host)
      try {
        execFileSync('ssh-keygen', ['-R', host], { stdio: 'ignore' })
      } catch {
        // no entry to remove
      }
    }
    return new Promise((done) => {
      const child = spawn('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        `havn@${host}`,
        command,
      ])
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('close', (code) => done({ code: code ?? 255, stdout, stderr }))
      child.on('error', () => done({ code: 255, stdout, stderr }))
    })
  }
}

async function main(): Promise<void> {
  let cli: Cli
  try {
    cli = parseProvisionArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const env = (k: string) => process.env[k]?.trim() ?? ''
  const missing = ['VULTR_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'].filter((k) => !env(k))
  if (missing.length) {
    console.error(`Missing from the environment: ${missing.join(', ')}`)
    process.exit(1)
  }

  const deps: ProvisionDeps = {
    fetch,
    vultrApiKey: env('VULTR_API_KEY'),
    cloudflareToken: env('CLOUDFLARE_API_TOKEN'),
    cloudflareZoneId: env('CLOUDFLARE_ZONE_ID'),
    ssh: makeSsh(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (m) => console.log(m),
    templates: {
      cloudInit: readFileSync(resolve(PROJECT_ROOT, 'deploy', 'cloud-init.yaml.template'), 'utf-8'),
      unit: readFileSync(resolve(PROJECT_ROOT, 'deploy', 'havn.service.template'), 'utf-8'),
    },
  }

  try {
    if (cli.dryRun) {
      buildUserData(cli.spec, deps.templates)
      await preflight(cli.spec, deps)
      console.log(
        `Dry run OK: ${hostNameFor(cli.spec.client)} and ${addressFor(cli.spec.client)} are free, ` +
          `user-data renders (${cli.spec.timezone}, ref ${cli.spec.gitRef ?? 'main'}). Nothing was created.`
      )
      return
    }

    const r = await provision(cli.spec, deps)
    console.log(`\nDone. ${r.hostName} (${r.ip}, ${r.region}), Vultr instance ${r.instanceId}.`)
    console.log(`SSH: ssh havn@${r.address}`)
    console.log('\nSend the client this email:\n')
    console.log(clientEmail({ clientName: cli.name, link: r.link }))
    console.log('Monitoring entry (config/hosted-instances.json):')
    console.log(JSON.stringify({ name: r.hostName, host: r.ip, owner: cli.name || cli.spec.client }))
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main()
}
