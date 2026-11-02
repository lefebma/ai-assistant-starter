#!/usr/bin/env bash
# One-time (and re-runnable) setup of the havn-connect relay, run by the
# operator on their own machine. Prints no secret.
#
#   deploy/connect-relay/setup.sh [path/to/google-web-client.json]
#
# - Deploys the Worker (creates connect.gethavn.ai on first run).
# - Generates SIGNING_SECRET and SEALING_SECRET if missing.
# - Generates the admin token if missing: the token goes to
#   $SECRETS_DIR/havn-connect-admin-token (mode 600), only its SHA-256 to the Worker.
# - With a Google "Web application" client JSON, sets GOOGLE_CLIENT_ID and
#   GOOGLE_CLIENT_SECRET from it.
set -euo pipefail
cd "$(dirname "$0")"
SECRETS_DIR="${SECRETS_DIR:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/ClaudeClaw-Secrets}"
ADMIN_FILE="$SECRETS_DIR/havn-connect-admin-token"
W=(npx -y wrangler@4)

"${W[@]}" deploy

have=$("${W[@]}" secret list 2>/dev/null || echo '[]')
missing() { ! grep -q "\"name\": *\"$1\"" <<<"$have"; }

for s in SIGNING_SECRET SEALING_SECRET; do
  if missing "$s"; then openssl rand -hex 32 | "${W[@]}" secret put "$s" >/dev/null && echo "set $s"; else echo "$s already set"; fi
done

if missing ADMIN_TOKEN_SHA256; then
  [ -e "$ADMIN_FILE" ] || (umask 077; openssl rand -hex 32 | tr -d '\n' > "$ADMIN_FILE")
  shasum -a 256 "$ADMIN_FILE" | cut -d' ' -f1 | "${W[@]}" secret put ADMIN_TOKEN_SHA256 >/dev/null
  echo "set ADMIN_TOKEN_SHA256 (token in $ADMIN_FILE)"
else
  echo "ADMIN_TOKEN_SHA256 already set"
fi

if [ -n "${1:-}" ]; then
  jq -er '.web.client_id' "$1" | tr -d '\n' | "${W[@]}" secret put GOOGLE_CLIENT_ID >/dev/null
  jq -er '.web.client_secret' "$1" | tr -d '\n' | "${W[@]}" secret put GOOGLE_CLIENT_SECRET >/dev/null
  echo "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from $1"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' 'https://connect.gethavn.ai/start?provider=outlook&box=none&nonce=check-0123456789abcdef' || true)
echo "relay answers /start with HTTP $code (400 is right: no such box)"
