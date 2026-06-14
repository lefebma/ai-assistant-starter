# Notion

Read pages and databases, search the workspace, and create new content. The integration token determines which pages and databases the assistant can see — pages must be explicitly shared with the integration in the Notion UI.

## Auth

Two options. Pick one and tell {{OWNER_NAME}} which is active:

1. **API token (REST):** stored at `~/.config/notion/api_key` (chmod 600) or in `NOTION_TOKEN` env. Use `curl` with `Authorization: Bearer $TOKEN` and `Notion-Version: 2022-06-28` headers.
2. **MCP server:** Install the official Notion MCP server (https://github.com/makenotion/notion-mcp-server) and the LLM gets first-class tools without writing HTTP code. Recommended if available — easier to compose with other tools.

Get an integration token at https://www.notion.so/profile/integrations. Share the pages/databases the assistant should see with that integration (in Notion: "..." → "Connect to" → pick your integration).

## Common workflows

### Search

Looking for "the page about X":

```bash
TOKEN=$(cat ~/.config/notion/api_key)
curl -sS -X POST https://api.notion.com/v1/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "X", "page_size": 10}' | jq '.results[] | {id, type: .object, title: (.properties.Name.title[0].plain_text // .properties.title.title[0].plain_text // "")}'
```

### Read a page

```bash
curl -sS https://api.notion.com/v1/blocks/$PAGE_ID/children \
  -H "Authorization: Bearer $TOKEN" \
  -H "Notion-Version: 2022-06-28" | jq '.results[]'
```

### Query a database

```bash
curl -sS -X POST https://api.notion.com/v1/databases/$DB_ID/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size": 20}' | jq '.results[] | .properties'
```

### Create a page

```bash
curl -sS -X POST https://api.notion.com/v1/pages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "DB_ID"},
    "properties": {
      "Name": {"title": [{"text": {"content": "Idea title"}}]}
    }
  }' | jq '.id, .url'
```

For a databse-as-inbox quick-capture pattern, identify the inbox database once (record the DB id and the property names), then create a page with `Status = Seed` (or whatever your inbox stage is) and the user's message as `Name`.

## When to invoke

- "Search Notion for X" / "find my page about Y" → search
- "What's in my [database name]" → query database
- "Capture this idea" / "log this in Notion" → create page in the appropriate inbox database
- "Show me page X" → read blocks

## Guardrails

- The token sees only pages explicitly shared with the integration. If a search returns nothing, the page probably isn't shared, not that it doesn't exist.
- Property names are case-sensitive and depend on each database's schema. Discover them by querying the database once with `.properties` and caching the names.
- Don't delete pages without confirming. Archive instead (`{"archived": true}` via PATCH).
- Notion's API rate limit is 3 req/sec averaged. Back off on 429.
