## Outlook Email & Calendar (Microsoft 365)

Account: {{EMAIL_ADDRESS}}

### Prerequisites
- MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID in .env
- Auth token obtained via `node scripts/ms-auth.js`

### Email
- Search: `node scripts/ms-mail.js search "query"`
- Read: `node scripts/ms-mail.js read <id>`
- Send draft: `node scripts/ms-mail.js draft --to "email" --subject "subject" --body "body"`

### Calendar
- Today's events: `node scripts/ms-calendar.js today`
- Date range: `node scripts/ms-calendar.js range "2026-01-01" "2026-01-31"`
- Create event: `node scripts/ms-calendar.js create --subject "Meeting" --start "2026-01-15T10:00" --end "2026-01-15T11:00"`
