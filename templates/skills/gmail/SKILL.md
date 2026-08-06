## Gmail & Google Calendar

Account: {{EMAIL_ADDRESS}}
CLI: `gog` ([gogcli](https://github.com/steipete/gogcli))

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
- **macOS / Linux**: `brew install openclaw/tap/gogcli`
- **Windows**: download `gogcli_<version>_windows_amd64.zip` from
  https://github.com/steipete/gogcli/releases, unzip it, and put `gog.exe`
  somewhere on PATH (`%USERPROFILE%\.local\bin` works)

Then authenticate, once per account:
`gog auth add {{EMAIL_ADDRESS}} --services gmail,calendar`

If it is installed somewhere unusual, set `GOG_BIN=<full path>` in `.env`
rather than editing code.
