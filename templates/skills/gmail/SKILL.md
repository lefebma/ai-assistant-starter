## Gmail & Google Calendar

Account: {{EMAIL_ADDRESS}}
CLI: `/opt/homebrew/bin/gog`

### Gmail
- Search: `gog gmail search "query" --account {{EMAIL_ADDRESS}}`
- Read: `gog gmail read <id> --account {{EMAIL_ADDRESS}}`
- Trash: `gog gmail trash <id> --account {{EMAIL_ADDRESS}}`

### Google Calendar
- Today's events: `gog calendar events --account {{EMAIL_ADDRESS}}`
- Date range: `gog calendar events --from "2026-01-01T00:00:00" --to "2026-01-01T23:59:59" --account {{EMAIL_ADDRESS}}`
