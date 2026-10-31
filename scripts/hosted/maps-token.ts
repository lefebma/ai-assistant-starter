/**
 * Manage hosted boxes' access to the maps proxy (card #266). Run from your own
 * machine with the Worker's address and your admin token in the environment:
 *
 *   HAVN_MAPS_URL=https://havn-maps.<you>.workers.dev HAVN_MAPS_ADMIN_TOKEN=... \
 *   npm run maps-token -- issue <box-name> <ip-or-host>   # new token, written to the box
 *   npm run maps-token -- revoke <box-name>               # that box only
 *   npm run maps-token -- quota <box-name> <requests>     # monthly requests for that box
 *   npm run maps-token -- usage [YYYY-MM]                 # requests and cost per box
 *
 * issue replaces any earlier token for the box, then stores the new one in
 * the box's vault (MAPS_PROXY_TOKEN) and MAPS_PROXY_URL in its .env, as havn.
 * The token travels on stdin, never on a command line. `npm run provision`
 * does this for a new box when the same two variables are set. Maps calls
 * read both fresh, so no restart is needed.
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { BOX_NAME } from '../../src/assurance/witness-protocol.js'

/**
 * Run as havn on the box: token into the vault, URL into .env, everything
 * else kept. The values ride inside the script as base64 (bash -s reads the
 * script from stdin, so a trailing data line would be read as script).
 */
export function connectScript(url: string, token: string, installDir = '$HOME/havn'): string {
  const b64 = (v: string) => Buffer.from(v, 'utf-8').toString('base64')
  return `set -euo pipefail
url=$(printf %s '${b64(url)}' | base64 -d)
cd "${installDir}"
printf %s '${b64(token)}' | base64 -d | node dist/scripts/vault-cli.js set MAPS_PROXY_TOKEN
f="${installDir}/.env"
touch "$f"
tmp=$(mktemp)
grep -vE '^(MAPS_PROXY_URL|MAPS_PROXY_TOKEN)=' "$f" > "$tmp" || true
printf 'MAPS_PROXY_URL=%s\\n' "$url" >> "$tmp"
cat "$tmp" > "$f"
rm -f "$tmp"
chmod 600 "$f"
echo "maps proxy connected"
`
}

export interface MapsAdmin {
  url: string
  adminToken: string
  fetch?: typeof fetch
}

async function admin(a: MapsAdmin, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await (a.fetch ?? fetch)(`${a.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${a.adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`The maps proxy refused (${res.status}): ${await res.text()}`)
  return res.json()
}

export async function issueToken(a: MapsAdmin, box: string): Promise<string> {
  if (!BOX_NAME.test(box)) throw new Error(`Bad box name "${box}": lowercase letters, digits and dashes.`)
  return ((await admin(a, 'POST', `/v1/admin/boxes/${box}/token`)) as { token: string }).token
}

export async function revokeToken(a: MapsAdmin, box: string): Promise<void> {
  if (!BOX_NAME.test(box)) throw new Error(`Bad box name "${box}": lowercase letters, digits and dashes.`)
  await admin(a, 'POST', `/v1/admin/boxes/${box}/revoke`)
}

/** Issue a token and write it to the box over ssh as havn. Throws with a plain reason. */
export async function connectBox(
  a: MapsAdmin,
  box: string,
  host: string,
  runOnBox: (host: string, script: string) => Promise<{ code: number; stderr?: string }> = sshScript,
): Promise<void> {
  const token = await issueToken(a, box)
  const r = await runOnBox(host, connectScript(a.url.replace(/\/+$/, ''), token))
  if (r.code !== 0) {
    throw new Error(`Writing the maps token on ${host} failed (exit ${r.code}). The new token is live but unused; re-run issue to replace it.`)
  }
}

export async function sshScript(host: string, script: string): Promise<{ code: number; stderr?: string }> {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `havn@${host}`, 'bash -s'], {
    input: script,
    encoding: 'utf-8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return { code: r.status ?? 255 }
}

/** The proxy's admin settings from the operator's environment, or null when unset. */
export function mapsAdminFromEnv(env: NodeJS.ProcessEnv = process.env): MapsAdmin | null {
  const url = (env.HAVN_MAPS_URL ?? '').trim()
  const adminToken = (env.HAVN_MAPS_ADMIN_TOKEN ?? '').trim()
  return url && adminToken ? { url, adminToken } : null
}

const USAGE = `Usage (with HAVN_MAPS_URL and HAVN_MAPS_ADMIN_TOKEN set):
  npm run maps-token -- issue <box-name> <ip-or-host>
  npm run maps-token -- revoke <box-name>
  npm run maps-token -- quota <box-name> <requests-per-month>
  npm run maps-token -- usage [YYYY-MM]`

export async function main(argv: string[]): Promise<void> {
  const a = mapsAdminFromEnv()
  const [cmd, ...rest] = argv
  if (!a || !cmd) {
    console.error(USAGE)
    process.exit(2)
  }
  try {
    if (cmd === 'issue' && rest.length === 2) {
      await connectBox(a, rest[0], rest[1])
      console.log(`Done. ${rest[1]} uses the maps proxy as ${rest[0]}; any earlier token for it no longer works.`)
    } else if (cmd === 'revoke' && rest.length === 1) {
      await revokeToken(a, rest[0])
      console.log(`Revoked. ${rest[0]} gets "travel time not available" until you issue it a new token.`)
    } else if (cmd === 'quota' && rest.length === 2) {
      const out = await admin(a, 'POST', `/v1/admin/boxes/${rest[0]}/quota`, { monthlyRequests: Number(rest[1]) })
      console.log(JSON.stringify(out))
    } else if (cmd === 'usage' && rest.length <= 1) {
      console.log(JSON.stringify(await admin(a, 'GET', `/v1/admin/usage${rest[0] ? `?month=${encodeURIComponent(rest[0])}` : ''}`), null, 2))
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
