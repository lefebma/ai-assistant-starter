#!/usr/bin/env bash
#
# wordsmith.sh — call Gemini API and emit prose for written-content tasks.
#
# Usage:
#   wordsmith.sh <model> <task>
#   echo "<source text>" | wordsmith.sh <model> <task>
#
# Models:
#   gemini-2.5-pro     — default, best prose quality
#   gemini-2.5-flash   — fast, cheaper, good for short rewrites
#
# Optional env vars:
#   WORDSMITH_VOICE    — system instruction (voice/style rules)
#   WORDSMITH_CONTEXT  — situational/brand context, prepended to task
#   GOOGLE_API_KEY     — overrides .env lookup
#
# Reads GOOGLE_API_KEY from project .env if not set in env.
# Writes Gemini's prose to stdout. Exits non-zero on API errors.

set -euo pipefail

MODEL="${1:-}"
TASK="${2:-}"

if [[ -z "$MODEL" || -z "$TASK" ]]; then
  echo "Usage: wordsmith.sh <model> <task>" >&2
  echo "Models: gemini-2.5-pro | gemini-2.5-flash" >&2
  exit 2
fi

# Resolve API key: env var wins, else .env in project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  ENV_FILE="$PROJECT_ROOT/.env"
  if [[ -f "$ENV_FILE" ]]; then
    GOOGLE_API_KEY=$(grep -E '^GOOGLE_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' | tr -d '\n\r')
  fi
fi

if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
  echo "Error: GOOGLE_API_KEY not set and not found in $PROJECT_ROOT/.env" >&2
  exit 1
fi

# Read piped stdin if present (treat as source text to operate on)
SOURCE=""
if [[ ! -t 0 ]]; then
  SOURCE=$(cat)
fi

# Compose user-turn text: optional context, optional source, task
USER_TEXT=""
if [[ -n "${WORDSMITH_CONTEXT:-}" ]]; then
  USER_TEXT+="Context:"$'\n'"$WORDSMITH_CONTEXT"$'\n\n'
fi
if [[ -n "$SOURCE" ]]; then
  USER_TEXT+="Source text:"$'\n'"$SOURCE"$'\n\n'
fi
USER_TEXT+="Task:"$'\n'"$TASK"

# Build payload
if [[ -n "${WORDSMITH_VOICE:-}" ]]; then
  PAYLOAD=$(jq -n \
    --arg voice "$WORDSMITH_VOICE" \
    --arg user "$USER_TEXT" \
    '{
      system_instruction: { parts: [{ text: $voice }] },
      contents: [{ role: "user", parts: [{ text: $user }] }],
      generationConfig: { temperature: 0.7 }
    }')
else
  PAYLOAD=$(jq -n \
    --arg user "$USER_TEXT" \
    '{
      contents: [{ role: "user", parts: [{ text: $user }] }],
      generationConfig: { temperature: 0.7 }
    }')
fi

URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GOOGLE_API_KEY}"

TIMEOUT=60
HTTP_CODE=$(curl -sS -o /tmp/wordsmith-response.json -w '%{http_code}' \
  --max-time "$TIMEOUT" \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

RESPONSE=$(cat /tmp/wordsmith-response.json)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: Gemini API returned HTTP $HTTP_CODE" >&2
  echo "$RESPONSE" | jq '.' >&2 2>/dev/null || echo "$RESPONSE" >&2
  rm -f /tmp/wordsmith-response.json
  exit 1
fi

CONTENT=$(echo "$RESPONSE" | jq -r '.candidates[0].content.parts | map(.text) | join("") // empty')

if [[ -z "$CONTENT" ]]; then
  echo "Error: empty response from Gemini" >&2
  echo "$RESPONSE" | jq '.' >&2
  rm -f /tmp/wordsmith-response.json
  exit 1
fi

echo "$CONTENT"
rm -f /tmp/wordsmith-response.json
