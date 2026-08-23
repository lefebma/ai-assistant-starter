#!/usr/bin/env bash
# Expose the Teams webhook on a hosted Havn box.
#
# Run as root, once, after the server exists and cloud-init has finished:
#   sudo bash /home/havn/havn/scripts/hosted/enable-teams.sh 5-161-197-79.sslip.io
#
# What it does, and nothing else:
#   - installs Caddy (Ubuntu 24.04 universe) for automatic Let's Encrypt TLS
#   - proxies ONLY https://<hostname>/api/teams/* to the app on 127.0.0.1:3030;
#     every other path answers 404, so the cockpit/voice surfaces stay private
#   - opens ufw 80/tcp (ACME HTTP-01 challenge) and 443/tcp; 3030 stays closed
#   - prints the messaging endpoint to paste into the Azure Bot registration
#
# sslip.io turns an IP into a resolvable name (1-2-3-4.sslip.io) so there is no
# DNS to manage; an owned subdomain works the same way.
set -euo pipefail

HOSTNAME_ARG="${1:-}"
if [[ -z "$HOSTNAME_ARG" ]]; then
  echo "Usage: enable-teams.sh <hostname>   (e.g. 5-161-197-79.sslip.io)" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
if ! [[ "$HOSTNAME_ARG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Not a valid hostname: $HOSTNAME_ARG" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<CADDY
# Havn: Teams webhook only. Written by scripts/hosted/enable-teams.sh.
${HOSTNAME_ARG} {
	handle /api/teams/* {
		reverse_proxy 127.0.0.1:3030
	}
	handle {
		respond 404
	}
}
CADDY

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null

systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

echo "Teams webhook exposed."
echo "  Messaging endpoint: https://${HOSTNAME_ARG}/api/teams/messages"
echo "  Caddy will obtain the certificate on first request; give it a minute."
echo "  Check: curl -si https://${HOSTNAME_ARG}/api/teams/messages | head -1   (expect 401 from the app, 404 elsewhere)"
