# Apollo.io Sales Intelligence

Search Apollo.io's database for companies, people, and email domains, and pull active-sequence performance reports. Read-only by default. No outbound email is sent by this skill.

## Auth

API key lives at `~/.apollo-api-key` as a single line (chmod 600).
Get one at: https://app.apollo.io/#/settings/integrations/api

All scripts source the key from that path (or `APOLLO_API_KEY` env var if set).

## Verbs

### Lookup (company / person / domain)

```bash
bash {{PROJECT_PATH}}/skills/apollo/apollo-lookup.sh company "Acme Inc"
bash {{PROJECT_PATH}}/skills/apollo/apollo-lookup.sh person "Jane Doe"
bash {{PROJECT_PATH}}/skills/apollo/apollo-lookup.sh domain "example.com"
```

Returns up to 5 matches as JSON (jq-friendly). Use this when {{OWNER_NAME}} asks "who is X", "look up company Y", "find Z at company Q", etc.

### Active sequences report

```bash
APOLLO_API_KEY=$(cat ~/.apollo-api-key) \
  node {{PROJECT_PATH}}/skills/apollo/apollo-active-sequences-report.js \
  [output_dir]
```

Pulls every active emailer campaign, totals delivered/opened/clicked/replied/bounced/unsubscribed, writes a CSV to `output_dir` (default `~/apollo-reports/`), and prints a per-sequence summary. Run weekly or on demand.

## When to invoke

- "Look up [company]" / "who is [person]" / "what do we know about [domain]"
- "Apollo report" / "sequence performance" / "how are my campaigns doing"
- "Add [person] to a sequence" → you have read access only via this skill; sequence membership changes happen in the Apollo web app or via the Apollo MCP

## Guardrails

- This skill does not send email, add contacts to sequences, or modify Apollo data. Add those via the Apollo dashboard or a separate write-enabled tool.
- Rate-limit: Apollo's free tier is generous for lookups but enrichment can be metered. If you get HTTP 429, wait and retry.
- Never log or echo the API key. The scripts read it once per call.
