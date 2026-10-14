/**
 * Connect a hosted box to the off-box audit witness (card #196, part 2). Run
 * from your own machine:
 *
 *   HAVN_WITNESS_URL=https://havn-audit.<you>.workers.dev \
 *   HAVN_WITNESS_ADMIN_TOKEN=... \
 *   npm run witness-token -- <box-name> <ip-or-host>
 *
 * Asks the witness for a new token for <box-name> (any earlier token for that
 * box stops working), then writes AUDIT_WITNESS_URL and AUDIT_WITNESS_TOKEN
 * into the box's .env as havn. The token travels on stdin, never on a command
 * line. The assistant starts shipping at its next restart; this does not
 * restart it.
 *
 * Box names are the witness's storage prefix: lowercase letters, digits and
 * dashes, e.g. havn-marina. Reusing a name continues that box's chain.
 */
import { spawnSync } from 'node:child_process'
import { BOX_NAME } from '../../src/assurance/witness-protocol.js'

/**
 * Run as havn on the box: replace the two lines in .env, keep everything else.
 * The values ride inside the script as base64 (bash -s reads the script from
 * stdin, so a trailing data line would be read as script, not by `read`).
 */
export function writeEnvScript(url: string, token: string): string {
  const b64 = (v: string) => Buffer.from(v, 'utf-8').toString('base64')
  return `set -euo pipefail
url=$(printf %s '${b64(url)}' | base64 -d)
token=$(printf %s '${b64(token)}' | base64 -d)
f="$HOME/havn/.env"
touch "$f"
tmp=$(mktemp)
grep -vE '^(AUDIT_WITNESS_URL|AUDIT_WITNESS_TOKEN)=' "$f" > "$tmp" || true
printf 'AUDIT_WITNESS_URL=%s\\nAUDIT_WITNESS_TOKEN=%s\\n' "$url" "$token" >> "$tmp"
cat "$tmp" > "$f"
rm -f "$tmp"
chmod 600 "$f"
echo "written to $f"
`
}

export async function main(argv: string[]): Promise<void> {
  const [box, host] = argv
  const url = (process.env.HAVN_WITNESS_URL ?? '').replace(/\/+$/, '')
  const admin = process.env.HAVN_WITNESS_ADMIN_TOKEN ?? ''
  if (!box || !host || !url || !admin) {
    console.error('Usage: HAVN_WITNESS_URL=... HAVN_WITNESS_ADMIN_TOKEN=... npm run witness-token -- <box-name> <ip-or-host>')
    process.exit(2)
  }
  if (!BOX_NAME.test(box)) {
    console.error(`Bad box name "${box}": lowercase letters, digits and dashes.`)
    process.exit(2)
  }
  const res = await fetch(`${url}/v1/admin/boxes/${box}/token`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } })
  if (!res.ok) {
    console.error(`The witness refused (${res.status}): ${await res.text()}`)
    process.exit(1)
  }
  const { token } = (await res.json()) as { token: string }
  console.log(`== token issued for ${box}`)
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `havn@${host}`, 'bash -s'], {
    input: writeEnvScript(url, token),
    encoding: 'utf-8',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (r.status !== 0) {
    console.error(`Writing .env on ${host} failed. The new token is live but unused; re-run to issue another.`)
    process.exit(1)
  }
  console.log(`Done. ${host} ships to the witness as ${box} after its next restart (sudo systemctl restart havn, as havn).`)
}

if (process.argv[1]?.match(/witness-token\.(ts|js)$/)) void main(process.argv.slice(2))
