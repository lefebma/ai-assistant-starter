#!/bin/bash
# Daily GitHub sync for ClaudeClaw.
# - Pulls latest from origin/main (rebase).
# - Auto-commits local changes as "auto-sync: <date>" if anything has drifted.
# - Pushes to origin/main.
# - Refuses to commit any file that looks like a secret, as a belt-and-braces guard.
# - Logs to ~/Projects/ClaudeClaw/logs/daily-sync.log.
# - Notifies via Telegram only on failure.
#
# Scheduled via ~/Library/LaunchAgents/com.claudeclaw.sync.plist.

set -o pipefail

PROJECT_ROOT="/Users/marclefebvre/Projects/ClaudeClaw"
LOG_DIR="$PROJECT_ROOT/logs"
LOG_FILE="$LOG_DIR/daily-sync.log"
NOTIFY="$PROJECT_ROOT/scripts/notify.sh"
BRANCH="main"
REMOTE="origin"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" >> "$LOG_FILE"
}

fail() {
  local msg="$1"
  log "FAIL: $msg"
  if [ -x "$NOTIFY" ]; then
    "$NOTIFY" "Umi sync failed: $msg (see $LOG_FILE)" >> "$LOG_FILE" 2>&1 || true
  fi
  exit 1
}

cd "$PROJECT_ROOT" || fail "cannot cd to $PROJECT_ROOT"

log "---- sync start ----"

# Make sure we're on the expected branch.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  fail "not on $BRANCH (currently on $CURRENT_BRANCH)"
fi

# Fetch first so we can rebase cleanly.
if ! git fetch "$REMOTE" "$BRANCH" >> "$LOG_FILE" 2>&1; then
  fail "git fetch failed"
fi

# If working tree is dirty, stage and commit before rebasing.
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  log "local drift detected, staging changes"
  git add -A >> "$LOG_FILE" 2>&1

  # Defensive secret scan on what's staged. If gitignore ever slips, abort.
  # Template files like .env.example / .env.sample are safe and explicitly allowed.
  SUSPICIOUS=$(git diff --cached --name-only \
    | grep -iE '(^|/)(\.env$|\.env\.|.*api-key$|.*\.pem$|.*\.key$|.*key_?pair.*|id_rsa|id_ed25519|secrets?/)' \
    | grep -ivE '(^|/)\.env\.(example|sample|template|dist)$' \
    || true)
  if [ -n "$SUSPICIOUS" ]; then
    git reset >> "$LOG_FILE" 2>&1
    fail "aborting: staged files look like secrets: $SUSPICIOUS"
  fi

  # Content scan: refuse any staged text file containing a private key header.
  KEY_HITS=$(git diff --cached --name-only -z \
    | xargs -0 -I{} grep -lE 'BEGIN (OPENSSH|RSA|DSA|EC|PGP) PRIVATE KEY' {} 2>/dev/null \
    || true)
  if [ -n "$KEY_HITS" ]; then
    git reset >> "$LOG_FILE" 2>&1
    fail "aborting: staged files contain private key material: $KEY_HITS"
  fi

  # Size scan: GitHub rejects pushes containing any file >100MB. Block at 95MB.
  OVERSIZE=$(git diff --cached --name-only -z \
    | xargs -0 -I{} sh -c 'sz=$(wc -c < "{}" 2>/dev/null || echo 0); [ "$sz" -gt 99614720 ] && echo "{} ($((sz/1024/1024))MB)"' \
    || true)
  if [ -n "$OVERSIZE" ]; then
    git reset >> "$LOG_FILE" 2>&1
    fail "aborting: staged files exceed 95MB (GitHub limit is 100MB): $OVERSIZE"
  fi

  if ! git diff --cached --quiet; then
    DATE=$(date '+%Y-%m-%d')
    HOST=$(hostname -s)
    if ! git commit -m "auto-sync: $DATE ($HOST)" >> "$LOG_FILE" 2>&1; then
      fail "git commit failed"
    fi
    log "committed local drift"
  else
    log "no tracked changes after staging (likely only ignored files)"
  fi
fi

# Rebase onto latest remote.
if ! git pull --rebase "$REMOTE" "$BRANCH" >> "$LOG_FILE" 2>&1; then
  # Try to abort rebase if it's mid-flight so we don't leave the repo in a half state.
  git rebase --abort >> "$LOG_FILE" 2>&1 || true
  fail "git pull --rebase conflict, needs manual attention"
fi

# Push if we're ahead. Retry on non-fast-forward in case the other Mac pushed
# between our rebase and our push. Up to 3 attempts with rebase between each.
AHEAD=$(git rev-list --count "$REMOTE/$BRANCH"..HEAD)
if [ "$AHEAD" -gt 0 ]; then
  PUSH_OK=0
  for ATTEMPT in 1 2 3; do
    if git push "$REMOTE" "$BRANCH" >> "$LOG_FILE" 2>&1; then
      log "pushed $AHEAD commit(s) to $REMOTE/$BRANCH (attempt $ATTEMPT)"
      PUSH_OK=1
      break
    fi
    log "push attempt $ATTEMPT failed, refetching and rebasing"
    if ! git pull --rebase "$REMOTE" "$BRANCH" >> "$LOG_FILE" 2>&1; then
      git rebase --abort >> "$LOG_FILE" 2>&1 || true
      fail "rebase conflict during push retry, needs manual attention"
    fi
    AHEAD=$(git rev-list --count "$REMOTE/$BRANCH"..HEAD)
    sleep $((ATTEMPT * 2))
  done
  [ "$PUSH_OK" -eq 1 ] || fail "git push failed after 3 attempts"
else
  log "nothing to push"
fi

log "---- sync ok ----"
exit 0
