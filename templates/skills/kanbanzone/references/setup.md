# First-Time Setup

This skill talks to Kanban Zone via its Public API v1.3. To use it you need an API key and (optionally) a default board ID. Multiple boards are supported — once configured, you can target any board you have access to.

## Prerequisites

- **Python 3.10 or newer.** Check with `python3 --version`. On macOS, the python.org installer is the cleanest path.
- **`certifi`** (Python package — CA root certificates). Install with `pip3 install certifi` or `pip3 install --break-system-packages certifi` on newer macOS setups. Without it, API calls fail with `SSL: CERTIFICATE_VERIFY_FAILED`.
  - If you installed Python from python.org and still hit SSL errors, run the bundled `Applications/Python 3.x/Install Certificates.command` once.
- **A Kanban Zone account with API access** (typically an Enterprise-tier plan).
- **A code editor or terminal** capable of editing your shell profile or creating files under `~/.config/`.

### Optional (for browser-fallback workflows)

- **A Chromium-based browser** (Chrome, Comet, Edge, Brave, Arc) for checklist and attachment operations — the two features the API doesn't expose.
- **The Chrome MCP extension** installed and connected. Not required for API-only use.

### No other Python dependencies

The script uses only the Python standard library plus `certifi`. No `requests`, no `httpx`, no virtualenv needed.

## 1. Generate your Kanban Zone API key

1. Log in to Kanban Zone at https://kanbanzone.io/
2. Go to **Organization Settings → Integrations → API Key**
   (Direct link: https://kanbanzone.io/settings/integrations)
3. Click **Generate API Key**
4. Copy the key immediately — some key types are only shown once.

> **Note:** API access may require an Enterprise-tier plan. If you don't see the API Key option, your plan may not include it.

> **Same key works for both `kanbanzone` and `kanbanzone-sway-crm`** — they use separate config directories so the credential never has to be duplicated; you can symlink or just paste the same key in both spots.

## 2. (Optional) Pick a default board

Skip this if you want to specify `--board` on every call. Otherwise, find the board you'll use most often:

1. Open the board in Kanban Zone.
2. URL is `https://kanbanzone.io/b/{BOARD_ID}` — copy the `{BOARD_ID}` portion.

Or after you finish step 3, run `kz list-boards` to see every board your key can access.

## 3. Store your credentials

Two options — pick one.

### Option A: Environment variables

Add to your shell profile (`~/.zshrc`, `~/.bashrc`):

```bash
export KZ_API_KEY="your-api-key-here"
export KZ_DEFAULT_BOARD_ID="your-default-board-id"   # optional
```

Reload the shell (`source ~/.zshrc`) and the helper script picks them up automatically.

### Option B: Config file

Create `~/.config/kanbanzone/config.json`:

```json
{
  "api_key": "your-api-key-here",
  "default_board_id": "your-default-board-id"
}
```

Set file permissions so only you can read it:

```bash
chmod 600 ~/.config/kanbanzone/config.json
```

`default_board_id` is optional — leave it out and every call must pass `--board ID`.

## 4. Verify

```bash
python3 ~/.claude/skills/kanbanzone/scripts/kz.py list-boards
```

Expected: a list of every board your key can access. Then verify a specific board:

```bash
python3 ~/.claude/skills/kanbanzone/scripts/kz.py verify --board <board-id>
```

Output looks like:

```
API reachable
Board "My Project Board" resolved
   Columns discovered: 7
   Parent groups: To Do, In Progress, Done
   Labels: Bug, Feature, Chore
```

If you see errors, check:
- API key is correctly copied (no trailing whitespace)
- Board ID matches the URL exactly
- Your plan includes API access

## 5. Per-board cache

`verify` (and any command that uses board metadata) caches column → columnId mapping per board to `~/.config/kanbanzone/boards/<board-id>.json`. Multiple boards each get their own file, so switching with `--board` is fast.

Refresh a board's cache after renaming columns:

```bash
python3 ~/.claude/skills/kanbanzone/scripts/kz.py refresh-cache --board <board-id>
```

## Troubleshooting

- **`SSL: CERTIFICATE_VERIFY_FAILED`** — Python can't find root CA certificates. Run `pip3 install --break-system-packages certifi`, or (on python.org installs) run `Install Certificates.command` from your Python install folder.
- **`python: command not found`** — Use `python3`.
- **HTTP 200 with body `"Bad Request"` or `"Unauthorized"`** — The API key isn't being sent as expected. The helper base64-encodes it for you; if your stored key is already encoded, set `KZ_KEY_PREENCODED=1`.
- **401 Unauthorized** — API key is wrong or expired. Regenerate in Kanban Zone settings.
- **404 Board not found** — Board ID is wrong, or your API key doesn't have access to that board. Run `kz list-boards` to see what's available.
- **403 Forbidden** — Your plan may not include API access. Check with Kanban Zone support.
- **`No column matching '<name>'`** — Your stage name doesn't match any column on the board. The error lists available columns. For columns with duplicate titles under different parents, use `Parent / Title` form (e.g., `Proposal / Waiting`).

## Security notes

- The API key is a secret. Don't commit it, paste it into shared docs, or include it in screenshots.
- The script never prints the key in output.
- If a key leaks, revoke it immediately in Kanban Zone settings and generate a new one.
