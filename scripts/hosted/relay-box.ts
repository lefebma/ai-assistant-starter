/**
 * Register hosted boxes with the sign-in relay (card #216), so the owner's
 * first /connect gmail or /connect outlook works with no operator SSH. Run
 * from your own machine with the relay's admin token in the environment:
 *
 *   HAVN_CONNECT_ADMIN_TOKEN=... npm run relay-box -- register <box> <ssh-host> <hostname> [--label "Havn assistant for Sam"]
 *   HAVN_CONNECT_ADMIN_TOKEN=... npm run relay-box -- remove <box>
 *   HAVN_CONNECT_ADMIN_TOKEN=... npm run relay-box -- list
 *
 * HAVN_CONNECT_URL overrides the relay (default https://connect.gethavn.ai).
 *
 * register (re)registers <box> with origin https://<hostname>, which replaces
 * any earlier hand-off key, then stores CONNECT_RELAY_URL, CONNECT_BOX_ID and
 * CONNECT_HANDOFF_KEY in the box's vault over SSH as havn. Every value travels
 * on stdin, never on a command line, and the key is never printed. Nothing is
 * written to .env, so this runs fine before web setup (card #301), and
 * `npm run provision` does it for a new box when the admin token is set.
 *
 * A box that is already running reads the three secrets once, at start:
 * restart it after registering (`sudo systemctl restart havn` as havn-admin).
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isValidHostname } from '../../src/deploy/teams-edge.js'

export const DEFAULT_RELAY_URL = 'https://connect.gethavn.ai'

/**
 * The relay's own rules (BOX_ID and cleanLabel in deploy/connect-relay/worker.ts),
 * checked here first so a bad value fails before anything is registered.
 */
const RELAY_BOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/
// eslint-disable-next-line no-control-regex
const BAD_LABEL = /[<>"&\u0000-\u001f]/

export interface RelayAdmin {
  url: string
  adminToken: string
  fetch?: typeof fetch
}

export interface Registration {
  box: string
  origin: string
  label: string
  handoffKey: string
}

/** The label the owner sees on the relay's sign-in page. */
export function defaultLabel(clientName: string, client: string): string {
  const name = clientName.replace(new RegExp(BAD_LABEL.source, 'g'), '').trim()
  const label = name ? `Havn assistant for ${name}` : `Havn assistant (${client})`
  return label.slice(0, 60).trim()
}

/** The label as the relay will store it, or null when the relay would refuse it. */
export function cleanRelayLabel(label: string): string | null {
  const s = label.trim()
  return s.length >= 1 && s.length <= 60 && !BAD_LABEL.test(s) ? s : null
}

function checkBox(box: string): void {
  if (!RELAY_BOX_ID.test(box)) throw new Error(`Bad box name "${box}": lowercase letters, digits and dashes.`)
}

async function admin(a: RelayAdmin, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await (a.fetch ?? fetch)(`${a.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${a.adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`The sign-in relay refused (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export async function registerBox(a: RelayAdmin, box: string, hostname: string, label: string): Promise<Registration> {
  checkBox(box)
  if (!isValidHostname(hostname)) throw new Error(`Not a valid hostname: ${hostname}`)
  const clean = cleanRelayLabel(label)
  if (!clean) throw new Error('The label must be 1 to 60 characters with no < > " &.')
  const r = (await admin(a, 'POST', `/admin/boxes/${box}`, { origin: `https://${hostname}`, label: clean })) as Partial<Registration>
  if (typeof r.handoffKey !== 'string' || r.handoffKey.length < 32) throw new Error('The sign-in relay answered without a hand-off key.')
  return { box, origin: String(r.origin), label: String(r.label), handoffKey: r.handoffKey }
}

export async function removeBox(a: RelayAdmin, box: string): Promise<void> {
  checkBox(box)
  await admin(a, 'DELETE', `/admin/boxes/${box}`)
}

/**
 * Run as havn on the box: the three /connect secrets into the vault, nothing
 * into .env. The values ride inside the script as base64 (bash -s reads the
 * script from stdin, so a trailing data line would be read as script).
 */
export function relayScript(relayUrl: string, box: string, handoffKey: string, installDir = '$HOME/havn'): string {
  const b64 = (v: string) => Buffer.from(v, 'utf-8').toString('base64')
  const set = (name: string, value: string) => `printf %s '${b64(value)}' | base64 -d | node dist/scripts/vault-cli.js set ${name}`
  return `set -euo pipefail
cd "${installDir}"
${set('CONNECT_RELAY_URL', relayUrl.replace(/\/+$/, ''))}
${set('CONNECT_BOX_ID', box)}
${set('CONNECT_HANDOFF_KEY', handoffKey)}
echo "sign-in relay connected"
`
}

/** Register the box and write its secrets over ssh as havn. Throws with a plain reason. */
export async function connectRelayBox(
  a: RelayAdmin,
  box: string,
  sshHost: string,
  hostname: string,
  label: string,
  runOnBox: (host: string, script: string) => Promise<{ code: number; stderr?: string }> = sshScript,
): Promise<Registration> {
  const reg = await registerBox(a, box, hostname, label)
  const r = await runOnBox(sshHost, relayScript(a.url, box, reg.handoffKey))
  if (r.code !== 0) {
    throw new Error(`Writing the relay secrets on ${sshHost} failed (exit ${r.code}). The box is registered with a key it does not have; re-run register to replace it.`)
  }
  return reg
}

export async function sshScript(host: string, script: string): Promise<{ code: number; stderr?: string }> {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `havn@${host}`, 'bash -s'], {
    input: script,
    encoding: 'utf-8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return { code: r.status ?? 255 }
}

/** The relay's admin settings from the operator's environment, or null when the token is unset. */
export function relayAdminFromEnv(env: NodeJS.ProcessEnv = process.env): RelayAdmin | null {
  const adminToken = (env.HAVN_CONNECT_ADMIN_TOKEN ?? '').trim()
  const url = (env.HAVN_CONNECT_URL ?? '').trim() || DEFAULT_RELAY_URL
  if (!adminToken) return null
  if (!url.startsWith('https://')) throw new Error('HAVN_CONNECT_URL must start with https://')
  return { url, adminToken }
}

const USAGE = `Usage (with HAVN_CONNECT_ADMIN_TOKEN set; HAVN_CONNECT_URL defaults to ${DEFAULT_RELAY_URL}):
  npm run relay-box -- register <box> <ssh-host> <hostname> [--label <text>]
  npm run relay-box -- remove <box>
  npm run relay-box -- list`

export async function main(argv: string[]): Promise<void> {
  let a: RelayAdmin | null
  try {
    a = relayAdminFromEnv()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
  const args = [...argv]
  let label: string | undefined
  const li = args.indexOf('--label')
  if (li >= 0) {
    label = args[li + 1]
    args.splice(li, 2)
  }
  const [cmd, ...rest] = args
  if (!a || !cmd) {
    console.error(USAGE)
    process.exit(2)
  }
  try {
    if (cmd === 'register' && rest.length === 3) {
      const [box, sshHost, hostname] = rest as [string, string, string]
      const reg = await connectRelayBox(a, box, sshHost, hostname, label ?? defaultLabel('', box.replace(/^havn-/, '')))
      console.log(`Done. ${box} is registered as "${reg.label}" at ${reg.origin}, and its secrets are in its vault.`)
      console.log('If the assistant is already running, restart it so /connect sees them: sudo systemctl restart havn (as havn-admin).')
    } else if (cmd === 'remove' && rest.length === 1) {
      await removeBox(a, rest[0]!)
      console.log(`Removed. ${rest[0]} can no longer receive sign-ins or renew Gmail through the relay.`)
    } else if (cmd === 'list' && rest.length === 0) {
      console.log(JSON.stringify(await admin(a, 'GET', '/admin/boxes'), null, 2))
    } else {
      console.error(USAGE)
      process.exit(2)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2))
