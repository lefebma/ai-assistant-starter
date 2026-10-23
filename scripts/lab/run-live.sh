#!/usr/bin/env bash
# Run the #225 live containment test against the lab SPACE deployment.
# Run ON THE VM, from a checkout of this branch, after space-lab-setup.sh has
# reached SPACE_LAB_READY and you have authenticated (installation.md#authenticate
# exports SPACE_API_URL, SPACE_DATA_PLANE_URL, SPACE_API_TOKEN).
#   node_modules must exist (npm ci) and PATH must include the Node 22 binary.
set -euo pipefail
: "${SPACE_API_URL:?authenticate first}" "${SPACE_API_TOKEN:?authenticate first}"
export SPACE_DATA_PLANE_URL="${SPACE_DATA_PLANE_URL:-http://127.0.0.1:8090}"
# Bind the mock sites to the VM's own LAN address: a SPACE guest cannot reach
# 127.0.0.1 (loopback is a platform guardrail), so loopback would fake containment.
export HAVN_LAB_HOST="${HAVN_LAB_HOST:-$(hostname -I | awk '{print $1}')}"
export SPACE_LIVE=1
echo "mock-site host: $HAVN_LAB_HOST"
npx vitest run tests/assurance-space-live.test.ts "$@"
