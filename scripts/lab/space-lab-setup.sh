#!/usr/bin/env bash
# Bring up SPACE's documented Kind dev stack on a disposable lab VM for the
# #225/#226 spikes. Run ON THE VM, as the login user, inside tmux:
#   tmux new-session -d -s space-setup 'bash space-lab-setup.sh 2>&1 | tee ~/space-setup.log'
# Never run this on a client box. It uses SPACE's development passwords and
# keys, and must hold no real credentials (no Havn, API or GitHub tokens).
set -euo pipefail

SPACE_COMMIT="${SPACE_COMMIT:-60437d062ab918100a7db7aa7c19d0c4ff765a91}"
SPACE_DIR="${SPACE_DIR:-$HOME/SPACE}"
export INSTALL_DIR="$HOME/.local/bin"
export PATH="$INSTALL_DIR:$PATH"
export SPACE_VENDOR_ROOT="$HOME/.local/share/space/vendor"
export SPACE_KIND_CLUSTER=space-local
# Bound Tilt's parallelism so the Kind apiserver stays responsive on 8 vCPU.
export SPACE_TILT_MAX_PARALLEL_UPDATES="${SPACE_TILT_MAX_PARALLEL_UPDATES:-2}"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN

stamp() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

stamp "host check"
[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]]
[[ -c /dev/kvm && -c /dev/net/tun ]]

stamp "base packages (docker.io, btrfs, tmux, jq)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  docker.io docker-buildx btrfs-progs tmux jq git curl python3 openssl
sudo usermod -aG docker,kvm "$USER"

# Group membership only applies to new logins; re-exec under sg so this run has it.
if ! id -nG | grep -qw docker || ! id -nG | grep -qw kvm || [[ ! -w /dev/kvm ]]; then
  if [[ -z "${SPACE_LAB_REEXEC:-}" ]]; then
    stamp "re-exec with docker and kvm groups"
    exec sg docker -c "sg kvm -c 'SPACE_LAB_REEXEC=1 bash $0'"
  fi
fi
docker version --format '{{.Server.Version}}'

stamp "clone SPACE at $SPACE_COMMIT"
if [[ ! -d "$SPACE_DIR/.git" ]]; then
  git init -q "$SPACE_DIR"
  git -C "$SPACE_DIR" remote add origin https://github.com/perplexityai/SPACE.git
fi
git -C "$SPACE_DIR" fetch -q --depth 1 origin "$SPACE_COMMIT"
git -C "$SPACE_DIR" checkout -q FETCH_HEAD
[[ "$(git -C "$SPACE_DIR" rev-parse HEAD)" == "$SPACE_COMMIT" ]]
cd "$SPACE_DIR"

path_line='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
mkdir -p "$INSTALL_DIR"
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  touch "$rc"; grep -Fxq "$path_line" "$rc" || printf '\n%s\n' "$path_line" >> "$rc"
done

stamp "install-prereqs.sh"
time bash infra/space/kind/scripts/install-prereqs.sh
for tool in kind kubectl helm grpcurl tilt go jq; do command -v "$tool" >/dev/null; done

stamp "install-fc-vendor.sh"
time bash infra/space/kind/scripts/install-fc-vendor.sh

stamp "up.sh (cold build)"
time bash infra/space/kind/scripts/up.sh

stamp "verify"
kubectl --context kind-space-local -n space wait --for=condition=complete job/space-seed-publish --timeout=300s
curl --noproxy '*' -fsS --max-time 15 http://127.0.0.1:8080/openapi-m1.json | jq -e '.openapi and .paths' >/dev/null
stamp "SPACE_LAB_READY"
