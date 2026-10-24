/**
 * Turn on the egress allowlist on an existing hosted box (card #231). Run from
 * your own machine, after `npm run split-admin` and once the box runs a
 * release with egress:
 *
 *   npm run enable-egress -- <ip-or-host> [--allow host,host] [--read host,host]
 *
 * New boxes get the same from cloud-init. As root (through havn-admin) this:
 *   - installs nftables if it is missing
 *   - writes /etc/havn/egress.env (root-owned: the assistant cannot widen its
 *     own allowlist) with EGRESS=enforce, the cgroup and the host lists
 *   - writes /usr/local/sbin/havn-egress-rules, which makes the tools cgroup
 *     and loads the nftables rule; a systemd drop-in runs it before every
 *     start (the rule names the cgroup, which is new on every start)
 *   - adds Delegate=yes so the assistant may move its tools into the cgroup
 *
 * It does not restart the assistant. Restart it (systemctl restart havn) when
 * the client is not mid-conversation, then run with --prove to check that a
 * process in the tools cgroup cannot connect out on its own.
 *
 * Safe to re-run: files are rewritten, the host lists replaced only when given.
 */
import { spawnSync } from 'node:child_process'
import { nftRules } from '../../src/egress/hosted.js'

export const CGROUP_REL = 'system.slice/havn.service/tools'
export const CGROUP = `/sys/fs/cgroup/${CGROUP_REL}`
export const PORTS: [number, number] = [47000, 47999]

export function setupScript(allow: string | null, read: string | null): string {
  const keep = (k: string, v: string | null) => v === null
    ? `$(grep -E '^${k}=' /etc/havn/egress.env 2>/dev/null | cut -d= -f2- || true)`
    : v
  return `set -euo pipefail
command -v nft >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y nftables
install -d -m 0755 /etc/havn
ALLOW="${keep('EGRESS_ALLOW', allow)}"
READ="${keep('EGRESS_READ', read)}"
cat > /etc/havn/egress.env.new <<EOF
EGRESS=enforce
EGRESS_CGROUP=${CGROUP}
EGRESS_PORTS=${PORTS[0]}-${PORTS[1]}
EGRESS_ALLOW=$ALLOW
EGRESS_READ=$READ
EOF
install -m 0644 -o root -g root /etc/havn/egress.env.new /etc/havn/egress.env && rm -f /etc/havn/egress.env.new
cat > /etc/havn/egress.nft <<'EOF'
${nftRules(CGROUP_REL, PORTS)}EOF
cat > /usr/local/sbin/havn-egress-rules <<'EOF'
#!/bin/sh
# Card #231. Runs as root before every start of havn.service: the cgroup is
# new each time, and the nftables rule must name the new one.
set -eu
mkdir -p ${CGROUP}
chown havn:havn ${CGROUP} ${CGROUP}/cgroup.procs
nft delete table inet havn_egress 2>/dev/null || true
nft -f /etc/havn/egress.nft
EOF
chmod 0755 /usr/local/sbin/havn-egress-rules
install -d -m 0755 /etc/systemd/system/havn.service.d
cat > /etc/systemd/system/havn.service.d/egress.conf <<'EOF'
# Card #231: tools run in their own cgroup, which may reach only the egress proxy.
[Service]
Delegate=yes
ExecStartPre=+/usr/local/sbin/havn-egress-rules
ExecStopPost=+/bin/sh -c 'nft delete table inet havn_egress 2>/dev/null || true'
Environment=EGRESS=enforce
Environment=EGRESS_CGROUP=${CGROUP}
EOF
systemctl daemon-reload
echo "egress set up; restart havn to apply"
`
}

/**
 * Run as havn after the restart. A process that joins the tools cgroup must
 * not reach the internet or DNS on its own; the same command outside it can.
 */
export const PROVE = `set -u
CG=${CGROUP}
[ -w "$CG/cgroup.procs" ] || { echo "tools cgroup missing or not writable: restart havn first"; exit 1; }
if curl -m 8 -sS -o /dev/null https://www.google.com 2>/dev/null; then echo "outside the cgroup: reaches the internet"; else echo "outside the cgroup: NO network (unexpected)"; fi
if sh -c 'echo $$ > "$0/cgroup.procs" && exec curl -m 8 -sS -o /dev/null https://www.google.com' "$CG" 2>/dev/null; then echo "inside the cgroup: CONNECTED (egress is NOT enforced)"; exit 1; else echo "inside the cgroup: blocked"; fi
if sh -c 'echo $$ > "$0/cgroup.procs" && exec curl -m 8 -sS -o /dev/null --noproxy "*" http://1.1.1.1' "$CG" 2>/dev/null; then echo "inside, by address: CONNECTED (egress is NOT enforced)"; exit 1; else echo "inside, by address: blocked"; fi
if sh -c 'echo $$ > "$0/cgroup.procs" && exec getent hosts example.com' "$CG" >/dev/null 2>&1; then echo "inside, DNS: resolved (DNS is not blocked)"; exit 1; else echo "inside, DNS: blocked"; fi
grep -q '^EGRESS=enforce' /etc/havn/egress.env && echo "settings: enforce"
`

function ssh(user: string, host: string, command: string, stdin?: string): { ok: boolean; out: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${user}@${host}`, command], {
    input: stdin,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return { ok: r.status === 0, out: r.stdout ?? '' }
}

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? '') : null
}

export function main(argv: string[]): void {
  const host = argv[0]
  if (!host || host.startsWith('--')) {
    console.error('Usage: npm run enable-egress -- <ip-or-host> [--allow host,host] [--read host,host] | <ip-or-host> --prove')
    process.exit(2)
  }
  if (argv.includes('--prove')) {
    const p = ssh('havn', host, 'bash -s', PROVE)
    process.stdout.write(p.out)
    if (!p.ok) { console.error(`Egress on ${host} is not holding. Check /etc/havn and journalctl -u havn.`); process.exit(1) }
    console.log(`Egress holds on ${host}.`)
    return
  }
  const s = ssh('havn-admin', host, 'sudo -n bash -s', setupScript(flag(argv, 'allow'), flag(argv, 'read')))
  process.stdout.write(s.out)
  if (!s.ok) { console.error('Setup failed. Is the box split (npm run split-admin)?'); process.exit(1) }
  console.log(`Done. Restart the assistant on ${host} when the client is not mid-conversation, then: npm run enable-egress -- ${host} --prove`)
}

if (process.argv[1]?.match(/enable-egress\.(ts|js)$/)) main(process.argv.slice(2))
