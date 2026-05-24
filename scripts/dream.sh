#!/bin/bash
# Nightly dreaming job for Umi.
# Consolidates the last 7 days of Claude Code session JSONLs into a DREAMS.md
# diary entry at ~/.claude/projects/.../memory/DREAMS.md. Promotion of
# candidates into actual memory files is deliberately left to Claude at
# session start, so this script only appends proposals.
#
# Logs to ~/Projects/ClaudeClaw/logs/dream.log.
# Notifies via Telegram only on failure.
#
# Scheduled via ~/Library/LaunchAgents/com.claudeclaw.dream.plist at 02:00 Toronto.

set -o pipefail

PROJECT_ROOT="/Users/marclefebvre/Projects/ClaudeClaw"
LOG_DIR="$PROJECT_ROOT/logs"
LOG_FILE="$LOG_DIR/dream.log"
NOTIFY="$PROJECT_ROOT/scripts/notify.sh"
NODE_BIN="/opt/homebrew/bin/node"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" >> "$LOG_FILE"
}

fail() {
  local msg="$1"
  log "FAIL: $msg"
  if [ -x "$NOTIFY" ]; then
    "$NOTIFY" "Umi dream failed: $msg (see $LOG_FILE)" >> "$LOG_FILE" 2>&1 || true
  fi
  exit 1
}

cd "$PROJECT_ROOT" || fail "cannot cd to $PROJECT_ROOT"

# The Claude Agent SDK refuses to nest inside another Claude Code session.
# Clear these so manual invocations from a CC terminal still work.
unset CLAUDECODE
unset CLAUDE_CODE_SSE_PORT

log "---- dream start ----"

if [ ! -f "dist/src/dreaming/index.js" ]; then
  fail "dist/src/dreaming/index.js missing, run npm run build"
fi

if "$NODE_BIN" dist/src/dreaming/index.js >> "$LOG_FILE" 2>&1; then
  log "---- dream ok ----"
  exit 0
else
  fail "dreaming agent exited non-zero"
fi
