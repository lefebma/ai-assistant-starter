# Gmail Cleanup Sweep

Zero-cost replacement for the LLM-based "Gmail Promo Cleanup" seed job.

## Why

The seed-job version spins up a full LLM session (~22k tokens) every run just to check
whether there are emails to trash. At daily frequency that's $12-15/day in API costs for
what is essentially a search-and-trash operation. This sweep does the same work
deterministically for free, and only dispatches a one-shot LLM task (via the built-in
scheduler) when it has results or errors to report. A clean run costs zero tokens.

## What it does

Two passes per run:

1. **Promo cleanup** -- trashes promotional emails older than 3 months
2. **Ancient cleanup** -- trashes any email older than 5 years

Messages go to Trash, not permanent deletion; Gmail purges Trash after 30 days on its
own, so you have a 30-day undo window.

Both passes protect starred messages and handle two Gmail API quirks:

- **Thread-scoped search**: `gog gmail search` returns thread matches, so a query
  like `-is:starred` can still return a starred message whose sibling matched.
  Every row is re-checked against its own labels and date before trashing.
- **Index lag**: after trashing a batch, Gmail's search index takes seconds to
  update, so just-trashed messages reappear on the next page. The sweep tracks
  trashed IDs and filters them out, preventing infinite loops.

The logic lives in `src/gmail-cleanup/` and is covered by the unit test suite
(`npm test`); the tests run against a fake Gmail boundary, so they never touch a
real mailbox.

## Prerequisites

- The `gog` CLI installed and authenticated for the account you want to sweep
  (the same tool the gmail skill uses)
- The project built: `npm run build`

## Setup

1. Add to `.env`:

   ```
   GMAIL_CLEANUP_ACCOUNT=you@gmail.com
   ```

   The report goes to `ALLOWED_CHAT_ID`; set `GMAIL_CLEANUP_CHAT_ID` to override.
   If `gog` isn't on the scheduler's PATH, set `GOG_PATH=/full/path/to/gog`.

2. Test with a dry run (searches and counts the first page; trashes nothing,
   dispatches nothing):

   ```bash
   node dist/scripts/gmail-cleanup.js --dry-run
   ```

3. Run it for real once and check the output:

   ```bash
   node dist/scripts/gmail-cleanup.js
   ```

   On a clean run it prints `clean run - nothing to trash, no dispatch` and exits.
   When something was trashed, it creates a one-shot scheduled task and your
   assistant messages you a short report within a couple of minutes.

## Scheduling

Until the installer's service manager owns recurring jobs, schedule the sweep with
your OS scheduler.

**macOS (launchd)** -- create `~/Library/LaunchAgents/com.assistant.gmail-cleanup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.assistant.gmail-cleanup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/full/path/to/node</string>
    <string>/full/path/to/ai-assistant-starter/dist/scripts/gmail-cleanup.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/gmail-cleanup.log</string>
  <key>StandardErrorPath</key><string>/tmp/gmail-cleanup.log</string>
</dict>
</plist>
```

Then: `launchctl load ~/Library/LaunchAgents/com.assistant.gmail-cleanup.plist`

**Linux (cron)**:

```
0 6 * * * /full/path/to/node /full/path/to/ai-assistant-starter/dist/scripts/gmail-cleanup.js >> /tmp/gmail-cleanup.log 2>&1
```

**Windows**: create a daily task in Task Scheduler running the same
`node dist\scripts\gmail-cleanup.js` command.

## Replacing the seed job

If you seeded the LLM-based "Gmail Promo Cleanup" job, delete it once the sweep is
scheduled (`/schedule list`, then `/schedule delete <id>`). Running both wastes money
at best and races the sweep at worst.

## Customizing

The queries and cutoffs are constants in `scripts/gmail-cleanup.ts`; the page size,
iteration cap, and chunk size live in `src/gmail-cleanup/sweep.ts`. Add another
`runSweep` call in the script for an extra cleanup pass.
