/**
 * Give an existing hosted box the append-only audit store (card #196). Run
 * from your own machine, after `npm run split-admin` and once the box runs a
 * release that records to it:
 *
 *   npm run enable-audit -- <ip-or-host>
 *
 * New boxes get the same from cloud-init. This creates
 * /var/lib/havn-audit/audit.jsonl owned by havn with the append-only flag, then
 * proves it as havn: appending works, rewriting and deleting do not. The app
 * picks the store up on its next start; this does not restart it.
 *
 * Safe to re-run: an existing log is kept, and the flag is set again.
 */
import { spawnSync } from 'node:child_process'

export const DIR = '/var/lib/havn-audit'

/** Run as root on the box, through havn-admin's sudo. Mirrors cloud-init. */
export const SETUP = `set -euo pipefail
install -d -m 0750 -o havn -g havn ${DIR}
[ -e ${DIR}/audit.jsonl ] || install -m 0640 -o havn -g havn /dev/null ${DIR}/audit.jsonl
chattr +a ${DIR}/audit.jsonl
lsattr ${DIR}/audit.jsonl
lsattr ${DIR}/audit.jsonl | awk '{print $1}' | grep -q a || { echo "append-only flag did not stick"; exit 1; }
`

/**
 * Run as havn. Appends nothing to the real log: an empty append proves the
 * file opens for appending without adding a line that would break the chain.
 * The truncate and delete probes would destroy an unflagged log, so they only
 * run once the flag is confirmed.
 */
export const PROVE = `f=${DIR}/audit.jsonl
lsattr "$f" | awk '{print $1}' | grep -q a || { echo "flag missing; not probing"; exit 1; }
printf '' >> "$f" && echo "append: ok" || { echo "append: FAILED"; exit 1; }
if : > "$f" 2>/dev/null; then echo "truncate: ALLOWED"; exit 1; else echo "truncate: refused"; fi
if rm -f "$f" 2>/dev/null && [ ! -e "$f" ]; then echo "delete: ALLOWED"; exit 1; else echo "delete: refused"; fi
if mv "$f" "$f.x" 2>/dev/null; then echo "rename: ALLOWED"; exit 1; else echo "rename: refused"; fi
`

function ssh(user: string, host: string, command: string, stdin?: string): { ok: boolean; out: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${user}@${host}`, command], {
    input: stdin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return { ok: r.status === 0, out: r.stdout ?? '' }
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

export function main(argv: string[]): void {
  const host = argv[0]
  if (!host) {
    console.error('Usage: npm run enable-audit -- <ip-or-host>')
    process.exit(2)
  }
  console.log(`== 1. create the append-only store on ${host}`)
  const s1 = ssh('havn-admin', host, 'sudo -n bash -s', SETUP)
  process.stdout.write(s1.out)
  if (!s1.ok) fail('Setup failed. Is the box split (npm run split-admin) and on ext4?')

  console.log('== 2. prove it as havn')
  const s2 = ssh('havn', host, 'bash -s', PROVE)
  process.stdout.write(s2.out)
  if (!s2.ok) fail(`The store on ${host} is not append-only for havn. Check ${DIR} by hand.`)

  console.log(`Done. The assistant on ${host} records every tool call to ${DIR}/audit.jsonl from its next start.`)
}

if (process.argv[1]?.match(/enable-audit\.(ts|js)$/)) main(process.argv.slice(2))
