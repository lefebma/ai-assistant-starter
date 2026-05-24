#!/bin/bash
# Wrapper for Playwright MCP that auto-connects to CDP if Chrome is running on port 9222.
# Pinned to the project's local @playwright/mcp install (no npx fetch, no @latest time-bomb).
# Falls back to npx if the local install is missing (e.g. fresh clone before npm install).

CDP_PORT=9222
CDP_ENDPOINT="http://127.0.0.1:${CDP_PORT}"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_MCP="${PROJECT_ROOT}/node_modules/@playwright/mcp/cli.js"

if [ -x "${LOCAL_MCP}" ]; then
  MCP_CMD=("${LOCAL_MCP}")
else
  MCP_CMD=(npx @playwright/mcp@latest)
fi

if curl -s --max-time 1 "${CDP_ENDPOINT}/json/version" > /dev/null 2>&1; then
  exec "${MCP_CMD[@]}" --cdp-endpoint "${CDP_ENDPOINT}" "$@"
else
  exec "${MCP_CMD[@]}" "$@"
fi
