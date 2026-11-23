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
 *     (/sys/fs/cgroup/havn-tools, root-owned), clears out anything left in it
 *     and loads the nftables rule; a systemd drop-in runs it before every start
 *   - installs havn-egressd, the root service that moves a tool into the
 *     cgroup (egress-helper.ts, card #307); only root can move a process in or
 *     out, so a tool cannot leave
 *
 * It does not restart the assistant. Restart it (systemctl restart havn) when
 * the client is not mid-conversation, then run with --prove (as root, through
 * havn-admin) to check that a
 * process in the tools cgroup cannot connect out on its own.
 *
 * Safe to re-run: files are rewritten, the host lists replaced only when given.
 */
import { spawnSync } from 'node:child_process'
import { nftRules } from '../../src/egress/hosted.js'
import { DAEMON_PATH, EGRESSD_PY, EGRESSD_UNIT, HELPER_DIR, JOIN_PATH, JOIN_PY, SOCKET_PATH, TOOLS_CGROUP, TOOLS_CGROUP_REL, UNIT_CGROUP } from './egress-helper.js'

export const CGROUP_REL = TOOLS_CGROUP_REL
export const CGROUP = TOOLS_CGROUP
export const PORTS: [number, number] = [47000, 47999]

export function setupScript(allow: string | null, read: string | null): string {
  const keep = (k: string, v: string | null) => v === null
    ? `$(grep -E '^${k}=' /etc/havn/egress.env 2>/dev/null | cut -d= -f2- || true)`
    : v
  return `set -euo pipefail
command -v nft >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y nftables
command -v python3 >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y python3-minimal
install -d -m 0755 /etc/havn
ALLOW="${keep('EGRESS_ALLOW', allow)}"
READ="${keep('EGRESS_READ', read)}"
cat > /etc/havn/egress.env.new <<EOF
EGRESS=enforce
EGRESS_CGROUP=${CGROUP}
EGRESS_JOIN=${JOIN_PATH}
EGRESS_PORTS=${PORTS[0]}-${PORTS[1]}
EGRESS_ALLOW=$ALLOW
EGRESS_READ=$READ
EOF
install -m 0644 -o root -g root /etc/havn/egress.env.new /etc/havn/egress.env && rm -f /etc/havn/egress.env.new
install -d -m 0755 -o root -g root ${HELPER_DIR}
cat > ${DAEMON_PATH}.new <<'EOF'
${EGRESSD_PY}EOF
cat > ${JOIN_PATH}.new <<'EOF'
${JOIN_PY}EOF
install -m 0755 -o root -g root ${DAEMON_PATH}.new ${DAEMON_PATH} && rm -f ${DAEMON_PATH}.new
install -m 0755 -o root -g root ${JOIN_PATH}.new ${JOIN_PATH} && rm -f ${JOIN_PATH}.new
cat > /etc/systemd/system/havn-egressd.service <<'EOF'
${EGRESSD_UNIT}EOF
cat > /etc/havn/egress.nft <<'EOF'
${nftRules(CGROUP_REL, PORTS)}EOF
cat > /usr/local/sbin/havn-egress-rules <<'EOF'
#!/bin/sh
# Cards #231, #307. Runs as root before every start of havn.service: makes
# the tools cgroup (root-owned, so a tool cannot leave it), clears out any
# tool a previous run left behind, and loads the nftables rule.
set -eu
mkdir -p ${CGROUP}
if [ -e ${CGROUP}/cgroup.kill ]; then echo 1 > ${CGROUP}/cgroup.kill; fi
nft delete table inet havn_egress 2>/dev/null || true
nft -f /etc/havn/egress.nft
EOF
chmod 0755 /usr/local/sbin/havn-egress-rules
install -d -m 0755 /etc/systemd/system/havn.service.d
cat > /etc/systemd/system/havn.service.d/egress.conf <<'EOF'
# Cards #231, #307: tools run in their own root-owned cgroup, which may reach only the egress proxy.
[Unit]
Wants=havn-egressd.service
After=havn-egressd.service
[Service]
ExecStartPre=+/usr/local/sbin/havn-egress-rules
# Tools live outside havn.service now, so stopping it does not stop them: this does.
ExecStopPost=+/bin/sh -c 'echo 1 > ${CGROUP}/cgroup.kill 2>/dev/null; nft delete table inet havn_egress 2>/dev/null || true'
Environment=EGRESS=enforce
Environment=EGRESS_CGROUP=${CGROUP}
Environment=EGRESS_JOIN=${JOIN_PATH}
EOF
systemctl daemon-reload
systemctl enable havn-egressd.service >/dev/null 2>&1
systemctl restart havn-egressd.service
for i in 1 2 3 4 5 6 7 8 9 10; do [ -S ${SOCKET_PATH} ] && break; sleep 0.5; done
[ -S ${SOCKET_PATH} ] || { echo "havn-egressd did not start"; exit 1; }
echo "egress set up; restart havn to apply"
`
}

/**
 * Run as root (through havn-admin) after the restart: a process from an ssh
 * session cannot move into the service's cgroup unless it is root, and a
 * check whose join fails would read as "blocked" and prove nothing (it did,
 * from 2026-11-05 to 1.84.4), and until 1.85.0 a tool could leave the cgroup
 * (card #307). Every check below joins through \`inside\`, which
 * stops the script if the join fails. A process that joins the tools cgroup must
 * not reach the internet or DNS on its own; the same command outside it can.
 */
export const PROVE = `set -u
CG=${CGROUP}
[ "$(id -u)" = 0 ] || { echo "run --prove as root (havn-admin with sudo)"; exit 1; }
# Joins the tools cgroup, or stops the whole check: a failed join must never read as "blocked".
inside() { sh -c 'echo $$ > "$0/cgroup.procs" || exit 99; exec "$@"' "$CG" "$@"; r=$?; [ $r = 99 ] && { echo "could not join the tools cgroup: nothing was proven"; exit 1; }; return $r; }
[ -w "$CG/cgroup.procs" ] || { echo "tools cgroup missing: restart havn first"; exit 1; }
inside true || exit 1
SVC=/sys/fs/cgroup${UNIT_CGROUP}
J=${JOIN_PATH}
[ -S ${SOCKET_PATH} ] || { echo "havn-egressd is not running: run enable-egress again"; exit 1; }
# Card #307: a tool, running as havn, must not be able to move itself out of the fence.
inside setpriv --reuid havn --regid havn --init-groups sh -c 'grep -qx "0::/${TOOLS_CGROUP_REL}" /proc/self/cgroup && [ "$(id -un)" = havn ]' || { echo "could not start a havn process in the tools cgroup: nothing was proven"; exit 1; }
if inside setpriv --reuid havn --regid havn --init-groups sh -c 'echo $$ > "$0/cgroup.procs" || echo $$ > /sys/fs/cgroup/cgroup.procs' "$SVC" 2>/dev/null; then echo "inside, leaving the cgroup: MOVED OUT (a tool can leave the fence)"; exit 1; else echo "inside, leaving the cgroup: refused"; fi
# The join helper moves a shell of the assistant in, and refuses one that is not the assistant's.
if sh -c 'echo $$ > "$0/cgroup.procs" || exit 99; exec setpriv --reuid havn --regid havn --init-groups sh -c '"'"'"$0" && grep -qx "0::/${TOOLS_CGROUP_REL}" /proc/self/cgroup'"'"' "$1"' "$SVC" "$J" 2>/dev/null; then echo "the join helper: moves a tool in"; else echo "the join helper: FAILED (tools cannot start)"; exit 1; fi
if setpriv --reuid havn --regid havn --init-groups sh -c '"$0" 2>/dev/null; r=$?; exit $r' "$J"; then echo "the join helper, asked from outside the assistant: AGREED (it must refuse)"; exit 1; else echo "the join helper, asked from outside the assistant: refused"; fi
if curl -m 8 -sS -o /dev/null https://www.google.com 2>/dev/null; then echo "outside the cgroup: reaches the internet"; else echo "outside the cgroup: NO network (unexpected)"; fi
if inside curl -m 8 -sS -o /dev/null https://www.google.com 2>/dev/null; then echo "inside the cgroup: CONNECTED (egress is NOT enforced)"; exit 1; else echo "inside the cgroup: blocked"; fi
if inside curl -m 8 -sS -o /dev/null --noproxy "*" http://1.1.1.1 2>/dev/null; then echo "inside, by address: CONNECTED (egress is NOT enforced)"; exit 1; else echo "inside, by address: blocked"; fi
if inside getent hosts example.com >/dev/null 2>&1; then echo "inside, DNS: resolved (DNS is not blocked)"; exit 1; else echo "inside, DNS: blocked"; fi
if inside timeout 6 bash -c "</dev/tcp/127.0.0.1/22" 2>/dev/null; then echo "inside, a local service (sshd): CONNECTED (loopback is NOT fenced)"; exit 1; else echo "inside, a local service: blocked"; fi
# Card #278: a tools listener (the browser's debugging port) is reachable from the tools, not from outside.
LP=$(( 39000 + RANDOM % 900 ))
inside timeout 20 python3 -I -c "import socket,sys;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((sys.argv[2],int(sys.argv[1])));s.listen(4);[s.accept()[0].close() for _ in range(4)]" "$LP" 127.0.0.1 & LPID=$!
sleep 1
if inside timeout 6 bash -c "</dev/tcp/127.0.0.1/$LP" 2>/dev/null; then echo "inside, a port the tools opened: connected"; else echo "inside, a port the tools opened: BLOCKED (browser tasks will hang)"; kill $LPID 2>/dev/null; exit 1; fi
if timeout 6 bash -c "</dev/tcp/127.0.0.1/$LP" 2>/dev/null; then echo "outside, a port the tools opened: CONNECTED (tools listeners are NOT fenced)"; kill $LPID 2>/dev/null; exit 1; else echo "outside, a port the tools opened: blocked"; fi
kill $LPID 2>/dev/null
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
    const p = ssh('havn-admin', host, 'sudo -n bash -s', PROVE)
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
