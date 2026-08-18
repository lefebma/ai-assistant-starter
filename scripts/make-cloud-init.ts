/**
 * Consultant-side generator for hosted-VPS user-data (docs/HOSTED-VPS.md).
 *
 * Renders deploy/cloud-init.yaml.template + deploy/havn.service.template into
 * per-client cloud-init user-data, then prints the provider create commands
 * that reference the emitted file. It never calls a cloud API and never
 * creates anything: the human runs the create command.
 *
 * Usage:
 *   npm run make-cloud-init -- --name havn-marina --timezone America/Toronto \
 *     --ssh-key ~/.ssh/id_ed25519.pub [--tailscale] [--repo owner/name] \
 *     [--ref main] [--install-dir /home/havn/havn] [--out path.yaml]
 *
 *   npm run make-cloud-init -- --config client.json   (flags override the file)
 *
 * Secrets come from the environment only — never from argv, where they would
 * land in shell history and `ps` output:
 *   GITHUB_DEPLOY_TOKEN   required; read access to the private repo
 *   TAILSCALE_AUTH_KEY    required only with --tailscale
 *
 * The rendered file CONTAINS those secrets. It is written 0600 into
 * deploy/rendered/ (gitignored); delete it once the server exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT } from '../src/env.js'
import {
  DEFAULT_GIT_REF,
  DEFAULT_GIT_REPO,
  DEFAULT_INSTALL_DIR,
  providerCommands,
  renderCloudInit,
  type ClientSpec,
} from '../src/deploy/cloud-init.js'

const USAGE = `Usage: npm run make-cloud-init -- --name <host> --timezone <IANA-tz> --ssh-key <key-or-.pub-path> [options]

Options:
  --config <file.json>   Read values from a JSON file; flags override it.
                         Keys: hostName, timezone, sshPublicKey OR
                         sshPublicKeyFile, tailscale (bool), gitRepo, gitRef,
                         installDir, out
  --name <host>          Client/host name, e.g. havn-marina
  --timezone <tz>        IANA timezone, e.g. America/Toronto
  --ssh-key <value>      SSH public key line, or a path to the .pub file
  --tailscale            Bake Tailscale in (reads TAILSCALE_AUTH_KEY from env)
                         and keep inbound SSH closed
  --repo <owner/name>    GitHub repo to deploy (default ${DEFAULT_GIT_REPO})
  --ref <ref>            Branch or tag to deploy (default ${DEFAULT_GIT_REF})
  --install-dir <path>   Install location on the box (default ${DEFAULT_INSTALL_DIR})
  --out <path>           Where to write the user-data
                         (default deploy/rendered/<host>.user-data.yaml)

Environment (secrets never go in argv):
  GITHUB_DEPLOY_TOKEN    required
  TAILSCALE_AUTH_KEY     required with --tailscale`

interface CliOptions extends Partial<ClientSpec> {
  tailscale?: boolean
  out?: string
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? resolve(homedir(), p.slice(2)) : p
}

/** A --ssh-key value is either the key line itself or a path to the .pub file. */
export function resolveSshKey(value: string, readFile: (p: string) => string, exists: (p: string) => boolean): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('ssh-') || trimmed.startsWith('ecdsa-') || trimmed.startsWith('sk-')) return trimmed
  const path = expandHome(trimmed)
  if (exists(path)) return readFile(path).trim()
  return trimmed // let validation produce the real complaint
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value\n\n${USAGE}`)
      return v
    }
    if (arg === '--config') {
      const raw = JSON.parse(readFileSync(expandHome(next()), 'utf-8')) as CliOptions & { sshPublicKeyFile?: string }
      const { sshPublicKeyFile, ...rest } = raw
      // Config first, flags later in the loop override it.
      Object.assign(opts, rest, opts)
      if (!opts.sshPublicKey && sshPublicKeyFile) {
        opts.sshPublicKey = readFileSync(expandHome(sshPublicKeyFile), 'utf-8').trim()
      }
    } else if (arg === '--name') opts.hostName = next()
    else if (arg === '--timezone') opts.timezone = next()
    else if (arg === '--ssh-key') opts.sshPublicKey = resolveSshKey(next(), (p) => readFileSync(p, 'utf-8'), existsSync)
    else if (arg === '--tailscale') opts.tailscale = true
    else if (arg === '--repo') opts.gitRepo = next()
    else if (arg === '--ref') opts.gitRef = next()
    else if (arg === '--install-dir') opts.installDir = next()
    else if (arg === '--out') opts.out = next()
    else if (arg === '--help' || arg === '-h') throw new Error(USAGE)
    else throw new Error(`Unknown option ${arg}\n\n${USAGE}`)
  }
  return opts
}

function main(): void {
  let opts: CliOptions
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  }

  const token = process.env.GITHUB_DEPLOY_TOKEN?.trim()
  if (!token) {
    console.error('GITHUB_DEPLOY_TOKEN is not set. Export it from your secret store first; it never goes in argv.')
    process.exit(1)
  }

  let tailscaleAuthKey: string | undefined
  if (opts.tailscale) {
    tailscaleAuthKey = process.env.TAILSCALE_AUTH_KEY?.trim()
    if (!tailscaleAuthKey) {
      console.error('--tailscale given but TAILSCALE_AUTH_KEY is not set in the environment.')
      process.exit(1)
    }
  }

  const spec: ClientSpec = {
    hostName: opts.hostName ?? '',
    timezone: opts.timezone ?? '',
    sshPublicKey: opts.sshPublicKey ?? '',
    githubDeployToken: token,
    tailscaleAuthKey,
    gitRepo: opts.gitRepo,
    gitRef: opts.gitRef,
    installDir: opts.installDir,
  }

  const cloudInitTemplate = readFileSync(resolve(PROJECT_ROOT, 'deploy', 'cloud-init.yaml.template'), 'utf-8')
  const unitTemplate = readFileSync(resolve(PROJECT_ROOT, 'deploy', 'havn.service.template'), 'utf-8')

  let rendered: string
  try {
    rendered = renderCloudInit(cloudInitTemplate, unitTemplate, spec)
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    console.error(`\n${USAGE}`)
    process.exit(1)
  }

  const outRel = opts.out ?? `deploy/rendered/${spec.hostName.trim()}.user-data.yaml`
  const outFile = isAbsolute(outRel) ? outRel : resolve(PROJECT_ROOT, outRel)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, rendered, { mode: 0o600 })

  console.log(`Wrote ${outFile} (0600 — it contains the deploy token${tailscaleAuthKey ? ' and Tailscale key' : ''}).`)
  console.log(
    tailscaleAuthKey
      ? 'SSH toggle: Tailscale mode — zero open inbound ports; reach the box over the tailnet.'
      : 'SSH toggle: no Tailscale — ufw allows inbound SSH (key-only) so you can log in.'
  )
  console.log('')
  console.log(providerCommands(outFile, spec.hostName.trim()))
  console.log('')
  console.log('After creation, SSH in and follow docs/HOSTED-VPS.md > Finishing steps.')
}

// Runs only as an entry point; importing this module (tests) stays side-effect
// free. tsx and compiled dist both satisfy the comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
