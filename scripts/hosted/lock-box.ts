/**
 * Close two ways out of the egress fence on an existing hosted box (card
 * #308). Run from your own machine, not on the box:
 *
 *   npm run lock-box -- <ip-or-host>
 *
 * 1. The service log. The unit wrote to logs/service.log with append:, which
 *    systemd opens as root and which follows symlinks. havn owns logs/, so a
 *    tool could replace the log with a link to /etc/sudoers.d/x and have root
 *    write there at the next start. Output now goes to the journal.
 * 2. ssh as havn. A tool can write ~havn/.ssh/authorized_keys, so a key it adds
 *    is a shell outside the fence. sshd now refuses havn; operators come in as
 *    havn-admin and use sudo -u havn.
 *
 * New boxes get both from cloud-init. Needs the two-login layout
 * (npm run split-admin) first. Safe to re-run. It restarts the assistant once,
 * so the log change takes effect.
 */
import { spawnSync } from 'node:child_process'
import { SSH_OPTS } from './box-ssh.js'

export const LOCK = `set -euo pipefail
# havn-admin must have its own keys before havn's login goes, or this locks
# the operator out.
test -s /home/havn-admin/.ssh/authorized_keys || { echo "havn-admin has no ssh keys; stopping" >&2; exit 1; }

for unit in havn havn-setup; do
  [ -f "/etc/systemd/system/$unit.service" ] || continue
  install -d -m 0755 "/etc/systemd/system/$unit.service.d"
  printf '[Service]\\n# Card #308: never an append: file in havn-owned logs/.\\nStandardOutput=journal\\nStandardError=journal\\n' > "/etc/systemd/system/$unit.service.d/20-journal.conf"
  chmod 0644 "/etc/systemd/system/$unit.service.d/20-journal.conf"
done
usermod -aG systemd-journal havn

printf 'DenyUsers havn\\n' > /etc/ssh/sshd_config.d/11-havn-no-login.conf
chmod 0644 /etc/ssh/sshd_config.d/11-havn-no-login.conf
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

systemctl daemon-reload
if systemctl is-active -q havn; then systemctl restart havn; fi
echo "locked"
`

export const CHECK = `set -uo pipefail
ok=1
for unit in havn havn-setup; do
  [ -f "/etc/systemd/system/$unit.service" ] || continue
  for k in StandardOutput StandardError; do
    v=$(systemctl show "$unit" -p "$k" --value)
    case "$v" in journal*) ;; *) echo "FAIL $unit $k=$v"; ok=0 ;; esac
  done
done
sshd -T -C user=havn,host=localhost,addr=127.0.0.1 2>/dev/null | grep -qi '^denyusers .*havn' || { echo "FAIL sshd does not deny havn"; ok=0; }
id -nG havn | tr ' ' '\\n' | grep -qx systemd-journal || { echo "FAIL havn not in systemd-journal"; ok=0; }
[ "$ok" = 1 ] && echo "CHECK_OK"
`

function ssh(user: string, host: string, command: string, stdin?: string): { ok: boolean; out: string } {
  const r = spawnSync('ssh', [...SSH_OPTS, `${user}@${host}`, command], {
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
    console.error('Usage: npm run lock-box -- <ip-or-host>')
    process.exit(2)
  }
  console.log(`== 1. check havn-admin on ${host}`)
  if (!ssh('havn-admin', host, 'sudo -n true').ok) fail(`havn-admin cannot sudo on ${host}. Run npm run split-admin -- ${host} first. Nothing was changed.`)

  console.log('== 2. journal logs, no ssh for havn')
  const s = ssh('havn-admin', host, 'sudo -n bash -s', LOCK)
  process.stdout.write(s.out)
  if (!s.ok) fail('The lock step failed. Check the output above; sshd was only reloaded if its config tested clean.')

  console.log('== 3. verify')
  if (!ssh('havn-admin', host, 'sudo -n true').ok) fail(`havn-admin lost access to ${host}. Fix from the provider console.`)
  const c = ssh('havn-admin', host, 'sudo -n bash -s', CHECK)
  process.stdout.write(c.out)
  if (!c.out.includes('CHECK_OK')) fail('The check failed; see the lines above.')
  if (ssh('havn', host, 'true').ok) fail(`ssh as havn still works on ${host}.`)
  console.log('ssh as havn: refused')
  console.log(`Done. Logs: ssh havn-admin@${host} journalctl -u havn. As the assistant: sudo -u havn -H bash`)
}

if (process.argv[1]?.match(/lock-box\.(ts|js)$/)) main(process.argv.slice(2))
