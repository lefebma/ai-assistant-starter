---
name: kanbanzone
description: Use this skill for any work on a Kanban Zone board. Trigger on requests like "list my Kanban Zone boards", "what's on my [name] board", "what's in [column]", "add a card to [board]", "move card #N to [column]", "comment on card #N", "find the card about [text]", "create a card on [board]", "what's stale in [column]". Multi-board by design — every command takes an optional `--board ID` flag, and `list-boards` discovers what's available.
---

# Kanban Zone — Generic Board CLI

This skill drives the Kanban Zone Public API v1.3 against **any** board the user's API key can access. It covers the four core motions: **read board state, create cards, move cards between columns, and update card fields**, plus **add comments** to a card's activity log. It uses the API as the primary access path, falling back to browser automation only for checklists and attachments (the two features the API doesn't expose).

## Multi-board model

Most commands take an optional `--board ID` flag. The board is resolved in this order:

1. `--board ID` flag on the command
2. Env var `KZ_DEFAULT_BOARD_ID` (or legacy `KZ_BOARD_ID`)
3. `default_board_id` in `~/.config/kanbanzone/config.json`

`list-boards` does NOT take `--board` — it lists every board the API key can see. Run it first if you don't know the board's public ID. Each board's column metadata is cached separately at `~/.config/kanbanzone/boards/<board-id>.json`, so switching with `--board` is fast.

## Configuration

The skill reads config from (in priority order):

1. Environment variables: `KZ_API_KEY` (required), `KZ_DEFAULT_BOARD_ID` (optional)
2. A config file at `~/.config/kanbanzone/config.json` with keys `api_key` and `default_board_id`

If neither config source is set, hand the user off to `references/setup.md`.

## Access strategy: API first, browser where needed

The Kanban Zone Public API (base URL `https://integrations.kanbanzone.io/v1/`) covers:

- Listing boards (`GET /boards`)
- Reading a board's columns and metadata
- Listing and reading cards
- Creating cards (single and bulk, via `POST /cards`)
- Updating card fields: title, description, label, owner, dueAt, priority, blocked state, custom fields, links
- Moving cards between columns (`POST /cards/{id}/move`)
- Adding comments to a card's activity log (`POST /cards/{id}/comments`)

Auth is base64-encoded API key sent as HTTP Basic. See `references/api-reference.md` for endpoint details, envelope patterns, and payload shapes. Use `scripts/kz.py` for the actual HTTP calls — it's a thin CLI that wraps the endpoints and handles the `CardItem` / `BoardItem` / `ColumnItem` envelope unwrapping. Always prefer calling this script over writing inline HTTP code.

The API does **not** cover:

- **Checklists / tasks** (Kanban Zone's to-do items inside a card)
- **Attachments** (file uploads)

For those two cases, fall back to browser automation via the Chrome MCP. See `references/browser-automation-tips.md` for patterns.

## Core workflows

### 1. Discover boards

When the user says "list my boards", "what boards do I have", "which Kanban Zone boards can I see":

```
kz list-boards
```

Returns `publicId  name  (cardCount)` per board. Use `--json` for machine output. Once you know the ID, every other command takes `--board <id>`.

### 2. Read board state

When the user asks "what's on the [name] board", "what's in [column]", "show me the active items":

1. Run `kz list-cards --board <id>` (or no `--board` to use the default).
2. Optionally narrow with `--column "Backlog"` (substring match against column titles).
3. Output is grouped by column; each card shows ID, title, label, owner, days-since-activity, due date.
4. Surface anything unusual the user should know — long idle times, missing owners on assigned-style boards, blockers — but don't lecture or invent stall thresholds the user didn't ask about. Generic boards may not have aging conventions.

### 3. Create cards

When the user says "add a card called X to [column]", "create a card on [board]", "add [thing] to my backlog":

1. Confirm board (use default unless the user named one).
2. Confirm target column. If unsure, run `kz refresh-cache --board <id>` and surface available columns from the cache.
3. Create:

```
kz create-card --board <id> --stage "Backlog" --title "Fix dashboard layout" \
   [--description "..."] [--label "Bug"] [--owner email@example.com] \
   [--due 2026-05-15] [--priority high]
```

For **bulk creation** (≥5 cards from a CSV or import), use `kz bulk-create --board <id> --from cards.csv` with a CSV containing `title,description,stage,label,owner` columns.

### 4. Move cards between columns

When the user says "move card #N to [column]", "mark #N as done", "advance [card title]":

1. If the user only knows the title, run `kz find --board <id> --title "partial name"` to get the card number.
2. Move:

```
kz move-card --board <id> --id N --stage "Done"
```

3. **Optionally** log a comment with the reason. Useful for boards that benefit from a history trail. Ask if you're unsure.

### 5. Update card fields

API-supported updates (use `kz update-card --board <id> --id N`):

- **Title / description:** `--title "..."`, `--description "..."`
- **Label:** `--label "Bug"` (must match a label defined on the board)
- **Owner:** `--owner user@example.com`
- **Due date:** `--due 2026-05-20`
- **Priority:** `--priority high` (low/normal/high/critical, board-dependent)
- **Block:** `--block "Waiting on infra"` / `--unblock`
- **Custom fields:** `--custom-field "Field Name=Value"` (repeatable)

Comments (use `kz comment --board <id> --id N --text "..."`).

Browser-only updates (use the Chrome MCP per `references/browser-automation-tips.md`):

- **Checklist item add/toggle:** always via browser
- **Attachment upload:** always via browser

## CLI reference (full subcommand list)

| Command | Purpose |
|---|---|
| `list-boards` | List every board the API key can access |
| `verify [--board]` | Check credentials and cache the board's column metadata |
| `refresh-cache [--board]` | Re-fetch column/label metadata for a board |
| `list-cards [--board] [--column NAME] [--json]` | List cards, optionally filtered by column |
| `find [--board] --title TEXT` | Find cards matching a title substring |
| `create-card [--board] --stage NAME --title TEXT [...]` | Create a single card |
| `bulk-create [--board] --from PATH` | Create many cards from a CSV |
| `move-card [--board] --id N --stage NAME` | Move a card to a column |
| `update-card [--board] --id N [...]` | Update card fields |
| `comment [--board] --id N --text TEXT` | Add a comment to a card's activity log |
| `dump [--board] PATH` | Raw GET against any API path (debug) |
| `diagnose` | Try each known auth form and report which works |

`--board ID` is accepted before or after the subcommand: `kz --board X list-cards` and `kz list-cards --board X` both work.

## Reference files

- `references/setup.md` — First-time user setup: API key, config file, verification.
- `references/api-reference.md` — Full Kanban Zone Public API v1.3 endpoint documentation, with payload shapes and envelope patterns.
- `references/browser-automation-tips.md` — Chrome MCP patterns for the two browser-only operations (checklists, attachments).

## Things to avoid

- **Don't delete cards.** If the user wants to remove one, ask whether they want it archived instead. Hard delete loses history.
- **Don't bulk-move without confirming.** Even obvious-looking batches should confirm before running, especially across boards the user doesn't actively monitor.
- **Don't store, log, or echo API keys in output.** The script reads keys from env vars or the config file and never prints them.
- **Don't override a default board silently.** If the user names a board different from `default_board_id`, surface that you're using `--board <other>` so they can correct mid-flight.
