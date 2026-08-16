## Gmail & Google Calendar

Account: {{EMAIL_ADDRESS}}
CLI: `gog` ([gogcli](https://github.com/openclaw/gogcli))

Call it as plain `gog` and let PATH resolve it. If that fails, the binary is
not installed or not on this machine's PATH: see "If gog is missing" below
rather than guessing at an absolute path.

### Gmail
- Search: `gog gmail search "query" --account {{EMAIL_ADDRESS}}`
- Read: `gog gmail read <id> --account {{EMAIL_ADDRESS}}`
- Trash: `gog gmail trash <id> --account {{EMAIL_ADDRESS}}`

### Google Calendar
- Today's events: `gog calendar events --account {{EMAIL_ADDRESS}}`
- Date range: `gog calendar events --from "2026-01-01T00:00:00" --to "2026-01-01T23:59:59" --account {{EMAIL_ADDRESS}}`

### If gog is missing

Say so plainly rather than improvising. This skill does nothing without the
binary installed and that account authenticated, and a confident-sounding
answer built on no data is worse than "I am not connected".

Install:
- **macOS / Linux with Homebrew**: `brew install gogcli` (it is in
  homebrew-core; do not add a third-party tap, which shadows it and fails)
- **Otherwise**: releases are compressed archives, not a bare binary, so there
  is an extract step. Download the one matching the machine from
  https://github.com/openclaw/gogcli/releases, unpack it, and put `gog` on
  PATH (`~/.local/bin` is probed automatically; `%USERPROFILE%\.local\bin` on
  Windows). On macOS also run
  `xattr -d com.apple.quarantine ~/.local/bin/gog`.

Authentication needs two steps, not one. `gog auth add` fails on its own
because gog ships no shared OAuth client:

1. Create a Google Cloud **Desktop app** OAuth client, enable the Gmail and
   Calendar APIs, then `gog auth credentials set <path-to-client_secret.json>`
2. `gog auth add {{EMAIL_ADDRESS}} --services gmail,calendar`

While that Google project stays in Testing mode, each address must be added as
a test user and refresh tokens expire after 7 days. Publishing the app removes
both limits and needs no Google review for these scopes.

If it is installed somewhere unusual, set `GOG_BIN=<full path>` in `.env`
rather than editing code.
