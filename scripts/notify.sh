#!/bin/bash
# Send a Telegram notification from a shell script
# Usage: ./scripts/notify.sh "Your message here"
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env
# Useful for sending progress updates from long-running Claude tasks.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env file found at $ENV_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | sed 's/^TELEGRAM_BOT_TOKEN=//' | tr -d '"')
CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | sed 's/^ALLOWED_CHAT_ID=//' | tr -d '"')

MESSAGE="${1:-}"

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: notify.sh <message>"
  echo "  Requires TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID in .env"
  exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d chat_id="$CHAT_ID" \
  -d text="$MESSAGE" > /dev/null

if [ $? -eq 0 ]; then
  echo "Sent to chat $CHAT_ID"
else
  echo "Failed to send" >&2
  exit 1
fi
