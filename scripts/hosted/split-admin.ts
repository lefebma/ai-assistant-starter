/**
 * Move a hosted box to the two-login layout (card #196). Run from your own
 * machine, not on the box:
 *
 *   npm run split-admin -- <ip-or-host>
 *
 * Boxes provisioned before this change have one login, havn, with
 * NOPASSWD: ALL. The assistant runs as havn, so anything it can write (its
 * ~/.bashrc, ~/.ssh/authorized_keys) is a step to root the next time someone
 * logs in or uses an added key. New boxes get the split from cloud-init; this
 * brings an existing one to the same state:
 *
 *   1. Create havn-admin with full sudo and a copy of havn's SSH keys.
 *   2. Prove you can log in as havn-admin and sudo. Stops here if not, with
 *      havn's sudo untouched, so this can never lock you out.
 *   3. Narrow havn's sudo to starting, stopping and restarting its own service.
 *   4. Prove both: havn-admin still has root, havn no longer does.
 *
 * Safe to re-run. Every sudoers change is checked with visudo before it is
 * kept, and the original files are backed up under /root/sudoers-backup-*.
 *
 * The stages below are bash because they run on the box (Ubuntu), fed to
 * `sudo bash -s` on stdin. They carry no arguments: ssh joins its arguments
 * into one remote command line, which loses quoting.
 */
import { spawnSync } from 'node:child_process'

const STAGE1 = `set -euo pipefail
if ! id havn-admin >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "Havn box administration" --groups sudo havn-admin
  passwd -l havn-admin >/dev/null
fi
chage -d "$(date +%F)" -M -1 -E -1 havn-admin
chmod 0750 /home/havn-admin
install -d -m 0700 -o havn-admin -g havn-admin /home/havn-admin/.ssh
# Copied once: later edits to havn's authorized_keys (which the assistant can
# make) never reach this file.
install -m 0600 -o havn-admin -g havn-admin /home/havn/.ssh/authorized_keys /home/havn-admin/.ssh/authorized_keys
tmp=$(mktemp)
echo 'havn-admin ALL=(ALL) NOPASSWD:ALL' > "$tmp"
visudo -cqf "$tmp"
install -m 0440 "$tmp" /etc/sudoers.d/91-havn-admin
rm -f "$tmp"
visudo -cq
echo "havn-admin ready"
`

const STAGE3 = `set -euo pipefail
NARROW='havn ALL=(root) NOPASSWD: /usr/bin/systemctl restart havn, /usr/bin/systemctl start havn, /usr/bin/systemctl stop havn, /usr/bin/systemctl enable --now havn'
backup=/root/sudoers-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$backup"
cp -a /etc/sudoers.d/. "$backup/"
restore() { echo "sudoers check failed; restoring $backup" >&2; cp -a "$backup/." /etc/sudoers.d/; rm -f /etc/sudoers.d/90-havn; }
# cloud-init's rule for havn: drop the havn lines, keep any others.
for f in /etc/sudoers.d/*; do
  case "$f" in /etc/sudoers.d/91-havn-admin|/etc/sudoers.d/90-havn|/etc/sudoers.d/README) continue ;; esac
  if grep -qE '^havn[[:space:]]' "$f"; then
    tmp=$(mktemp)
    grep -vE '^havn[[:space:]]' "$f" > "$tmp" || true
    visudo -cqf "$tmp" || { rm -f "$tmp"; restore; exit 1; }
    install -m 0440 "$tmp" "$f"
    rm -f "$tmp"
  fi
done
tmp=$(mktemp)
echo "$NARROW" > "$tmp"
visudo -cqf "$tmp" || { rm -f "$tmp"; restore; exit 1; }
install -m 0440 "$tmp" /etc/sudoers.d/90-havn
rm -f "$tmp"
gpasswd -d havn sudo >/dev/null 2>&1 || true
visudo -cq || { restore; exit 1; }
echo "backup: $backup"
`

function ssh(user: string, host: string, command: string, stdin?: string, quiet = false): { ok: boolean; out: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${user}@${host}`, command], {
    input: stdin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', quiet ? 'ignore' : 'inherit'],
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
    console.error('Usage: npm run split-admin -- <ip-or-host>')
    process.exit(2)
  }

  console.log(`== 1. create havn-admin on ${host}`)
  // Stage 1 runs through havn's current sudo. A re-run on a box that is
  // already split has no such sudo, so go straight to the check.
  if (ssh('havn', host, 'sudo -n true', undefined, true).ok) {
    const s1 = ssh('havn', host, 'sudo -n bash -s', STAGE1)
    process.stdout.write(s1.out)
    if (!s1.ok) fail('Creating havn-admin failed. Nothing about havn was changed.')
  } else {
    console.log('havn has no general sudo here; checking the existing havn-admin')
  }

  console.log('== 2. check havn-admin can log in and use sudo')
  if (!ssh('havn-admin', host, 'sudo -n true').ok) {
    fail(`havn-admin cannot sudo on ${host}. Stopped before touching havn's sudo.`)
  }
  console.log('ok')

  console.log("== 3. narrow havn's sudo")
  const s3 = ssh('havn-admin', host, 'sudo -n bash -s', STAGE3)
  process.stdout.write(s3.out)
  if (!s3.ok) fail('Narrowing failed; the stage restored the sudoers backup it took.')

  console.log('== 4. verify')
  if (!ssh('havn-admin', host, 'sudo -n true').ok) fail(`havn-admin lost sudo on ${host}. Fix from the provider console.`)
  console.log('havn-admin: root ok')
  if (ssh('havn', host, 'sudo -n true', undefined, true).ok) {
    fail(`havn still has general sudo on ${host}. Check /etc/sudoers.d by hand.`)
  }
  console.log('havn: general sudo gone')
  const list = ssh('havn', host, 'sudo -n -l').out
  const at = list.indexOf('may run')
  console.log(at >= 0 ? list.slice(list.lastIndexOf('\n', at) + 1).trimEnd() : list.trimEnd())
  console.log(`Done. Root work on ${host} now goes through havn-admin@${host}.`)
}

if (process.argv[1]?.match(/split-admin\.(ts|js)$/)) main(process.argv.slice(2))
