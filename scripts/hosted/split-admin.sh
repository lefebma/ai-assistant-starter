#!/usr/bin/env bash
# Move a hosted box to the two-login layout (card #196). Run from your own
# machine, not on the box:
#
#   scripts/hosted/split-admin.sh <ip-or-host>
#
# Boxes provisioned before this change have one login, havn, with
# NOPASSWD: ALL. The assistant runs as havn, so anything it can write (its
# ~/.bashrc, ~/.ssh/authorized_keys) is a step to root the next time someone
# logs in or uses an added key. New boxes get the split from cloud-init; this
# brings an existing one to the same state:
#
#   1. Create havn-admin with full sudo and a copy of havn's SSH keys.
#   2. Prove you can log in as havn-admin and sudo. Stops here if not, with
#      havn's sudo untouched, so this can never lock you out.
#   3. Narrow havn's sudo to starting, stopping and restarting its own service.
#   4. Prove both: havn-admin still has root, havn no longer does.
#
# Safe to re-run. Every sudoers change is checked with visudo before it is
# kept, and the original files are backed up under /root/sudoers-backup-*.
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] || { echo "Usage: $0 <ip-or-host>" >&2; exit 2; }
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
NARROW='havn ALL=(root) NOPASSWD: /usr/bin/systemctl restart havn, /usr/bin/systemctl start havn, /usr/bin/systemctl stop havn, /usr/bin/systemctl enable --now havn'

echo "== 1. create havn-admin on $HOST"
# Stage 1 runs through havn's current sudo. A re-run on a box that is already
# split has no such sudo, so go straight to the check.
if "${SSH[@]}" "havn@$HOST" sudo -n true 2>/dev/null; then
"${SSH[@]}" "havn@$HOST" sudo -n bash -s <<'STAGE1'
set -euo pipefail
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
STAGE1
else
  echo "havn has no general sudo here; checking the existing havn-admin"
fi

echo "== 2. check havn-admin can log in and use sudo"
if ! "${SSH[@]}" "havn-admin@$HOST" sudo -n true; then
  echo "havn-admin cannot sudo on $HOST. Stopped before touching havn's sudo." >&2
  exit 1
fi
echo "ok"

echo "== 3. narrow havn's sudo"
"${SSH[@]}" "havn-admin@$HOST" sudo -n env "NARROW=$NARROW" bash -s <<'STAGE3'
set -euo pipefail
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
STAGE3

echo "== 4. verify"
"${SSH[@]}" "havn-admin@$HOST" sudo -n true && echo "havn-admin: root ok"
if "${SSH[@]}" "havn@$HOST" sudo -n true 2>/dev/null; then
  echo "havn still has general sudo on $HOST. Check /etc/sudoers.d by hand." >&2
  exit 1
fi
echo "havn: general sudo gone"
"${SSH[@]}" "havn@$HOST" sudo -n -l | sed -n '/may run/,$p'
echo "Done. Root work on $HOST now goes through havn-admin@$HOST."
