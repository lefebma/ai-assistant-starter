#!/usr/bin/env bash
#
# research.sh — call Perplexity API and emit markdown with citations.
#
# Usage:
#   research.sh <model> <query>
#
# Optional env vars:
#   PPLX_CONTEXT  — system message prepended to the query
#
# Reads API key from ~/.perplexity-api-key.
# Writes markdown (content + Sources block) to stdout.
# Exits non-zero on API errors.

set -euo pipefail

MODEL="${1:-}"
QUERY="${2:-}"

if [[ -z "$MODEL" || -z "$QUERY" ]]; then
  echo "Usage: research.sh <model> <query>" >&2
  echo "Models: sonar-pro | sonar-reasoning-pro | sonar-deep-research" >&2
  exit 2
fi

KEY_FILE="${HOME}/.perplexity-api-key"
if [[ ! -f "$KEY_FILE" ]]; then
  echo "Error: Perplexity API key not found at $KEY_FILE" >&2
  exit 1
fi

KEY=$(tr -d '\n\r ' < "$KEY_FILE")
if [[ -z "$KEY" ]]; then
  echo "Error: $KEY_FILE is empty" >&2
  exit 1
fi

# Build messages array
if [[ -n "${PPLX_CONTEXT:-}" ]]; then
  MESSAGES=$(jq -n --arg c "$PPLX_CONTEXT" --arg q "$QUERY" \
    '[{role: "system", content: $c}, {role: "user", content: $q}]')
else
  MESSAGES=$(jq -n --arg q "$QUERY" \
    '[{role: "user", content: $q}]')
fi

PAYLOAD=$(jq -n --arg m "$MODEL" --argjson msgs "$MESSAGES" \
  '{model: $m, messages: $msgs, return_citations: true}')

# Deep research can take several minutes; give it a generous timeout
TIMEOUT=600

HTTP_CODE=$(curl -sS -o /tmp/pplx-response.json -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST https://api.perplexity.ai/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

RESPONSE=$(cat /tmp/pplx-response.json)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: Perplexity API returned HTTP $HTTP_CODE" >&2
  echo "$RESPONSE" | jq '.' >&2 2>/dev/null || echo "$RESPONSE" >&2
  rm -f /tmp/pplx-response.json
  exit 1
fi

# Extract content and citations
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')
if [[ -z "$CONTENT" ]]; then
  echo "Error: empty response content" >&2
  echo "$RESPONSE" | jq '.' >&2
  rm -f /tmp/pplx-response.json
  exit 1
fi

CITATIONS=$(echo "$RESPONSE" | jq -r '
  (.citations // .search_results // [])
  | if length == 0 then empty
    else to_entries
      | map("[\(.key + 1)] " + (if (.value | type) == "string" then .value else (.value.url // .value | tostring) end))
      | join("\n")
    end
')

echo "$CONTENT"
if [[ -n "$CITATIONS" ]]; then
  echo ""
  echo "## Sources"
  echo "$CITATIONS"
fi

rm -f /tmp/pplx-response.json
