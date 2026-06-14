# Kanban Zone Public API v1.3 — Reference

**Base URL:** `https://integrations.kanbanzone.io/v1/`

**Auth:** Organization API Key, **base64-encoded**, sent as an HTTP Basic auth header:

```
Authorization: Basic {base64(api_key)}
```

The raw API key (as shown in the Kanban Zone integrations UI) is *not* what goes on the wire — it must be base64-encoded first. The helper script (`scripts/sway.py`) does this automatically; set `KZ_KEY_PREENCODED=1` if your stored key is already encoded.

The query-parameter form (`?api_token=...`) is also accepted by the server with the same encoded value, but the skill uses the header form.

**Official docs:** https://kanbanzone.com/knowledge-base/api/ (narrative guide) and the SwaggerHub spec at https://app.swaggerhub.com/apis/kanbanzone.io/integrations-kanbanzone.io/1.3-oas3 (machine-readable).

## Response envelope pattern

**Important:** most v1.3 responses wrap each record in a type tag. Peel these wrappers before using the payload.

- Boards: `{ "count": N, "boards": [ { "BoardItem": { ...fields... } } ] }`
- Columns (when returned as part of a board): `[ { "ColumnItem": { ...fields... } } ]`
- Cards (list and single): wrapped as `{ "CardItem": { ...fields... } }`

The helper script handles all three (`_unwrap_board`, `_unwrap_card`, and the column unwrap in `save_cache`).

## All endpoints (v1.3)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/boards` | List all boards in your organization |
| GET | `/board/{board}` | Get a board's metadata (add `?includeColumns=true&includeCustomFields=true` to get structure) |
| GET | `/cards` | List cards on a board (paginated, max 100 per page) |
| GET | `/cards/{id}` | Get a single card by number |
| POST | `/cards` | Create one or more cards (always an array payload) |
| PUT | `/cards/{id}` | Update a card's fields |
| POST | `/cards/{id}/move` | Move a card to a different column |
| GET | `/cards/{id}/comments` | List a card's comments |
| POST | `/cards/{id}/comments` | Add a comment to a card |

**Note on paths:** everything is plural (`/cards`, `/cards/{id}`, `/cards/{id}/move`). The singular `/card` path is not valid in v1.3.

## `GET /boards`

Lists all boards the API key can access. Use this to verify auth and discover board IDs.

Each `BoardItem` includes `publicId` (the string in the board URL, e.g. `aBcD1234`), `name`, `isArchived`, plus summary counts.

## `GET /board/{board}`

**Path param:** `board` — the board's public ID.

**Required query params for structure:**

- `includeColumns=true` — returns the column list (otherwise only aggregate counts are returned)
- `includeCustomFields=true` — returns custom-field definitions

Without those flags, the response contains only the board's name and a few metrics — no columns.

Each column (wrapped in `ColumnItem`) includes:

- `columnId` — opaque ID used when creating/moving cards
- `title` — the column's display name (note: *title*, not `name`)
- `parent`, `parentTitle` — populated for sub-rows (e.g. a "Waiting" column that lives under a "Call" parent)
- `columnState` — lifecycle state (e.g. "In Progress", "Done")
- `type` — structural type
- `minWIP`, `maxWIP`, `explicitAgreement` — WIP policy fields

Multiple columns can share a title (e.g. several "Waiting" sub-rows under different parents). Disambiguate with the "Parent / Title" form — the helper's `resolve_column` does this automatically and errors with a helpful list when ambiguous.

## `GET /cards`

**Query params:**

- `board` (required) — board public ID
- `page` (optional, default 1)
- `count` (optional, max 100)

Paginated list of cards. Iterate until a page returns fewer than `count` rows.

Each card (wrapped in `CardItem`) includes:

- Identity: `number` (the visible card ID), `title`, `description`, `boardPublicId`, `boardTitle`
- Column placement: `columnId`, `columnTitle`, `columnState`
- Classification: `label` (string), `owner` (string/email), `watchers`
- Dates: `createdAt`, `lastActionAt`, `startDate`, `dueAt`, `doneAt`, `archivedAt`, `lastUpdatedBy`
- Workflow: `blocked`, `blockedReason`, `completedTasksCount`, `totalTasksCount`
- Extras: `customFields`, `links`

There is no `timeInColumn` field. For stall detection, compute days-idle from `lastActionAt` — this is what the helper's "Nd idle" display uses.

## `GET /cards/{id}`

**Query param:** `board` (required) — board public ID.

Returns a single `CardItem` with full detail. The `{id}` segment is the card `number` (visible on the board).

## `POST /cards`

Creates one or more cards. **Always an array payload, even for a single card.**

**Body:**
```json
{
  "board": "aBcD1234",
  "cards": [
    {
      "title": "Jane Doe",
      "description": "Head of Ops at Acme | Toronto\n\nReferred by Imtiaz.",
      "columnId": "{target_column_id}",
      "label": "Warm Lead",
      "owner": "user@example.com",
      "dueAt": "2026-04-20T00:00:00Z",
      "priority": "normal",
      "customFields": [],
      "addToTop": true
    }
  ]
}
```

Returns an array of created cards, each wrapped in `CardItem`. Use for bulk imports (Apollo, LinkedIn Sales Navigator, event lists) as well as single creates.

## `PUT /cards/{id}`

**Path param:** `id` — card number.

**Body (all fields optional — send only what you want to change):**
```json
{
  "board": "aBcD1234",
  "title": "Jane Doe (updated)",
  "description": "...",
  "columnId": "{new_column_id}",
  "label": "Hot Lead",
  "owner": "user@example.com",
  "dueAt": "2026-04-25T00:00:00Z",
  "priority": "high",
  "size": "medium",
  "blocked": true,
  "blockedBy": "CFO",
  "blockedReason": "Waiting on budget sign-off",
  "watchers": ["teammate@example.com"],
  "customFields": [
    {"name": "Deal Value", "value": "12000"},
    {"name": "ICP Segment", "value": "Ops"}
  ],
  "links": {
    "add": [{"number": 123, "type": "related"}],
    "remove": [{"number": 45}]
  }
}
```

**Mirror cards:** if the card is mirrored across boards, `board` is required to disambiguate.

`PUT /cards/{id}` can change `columnId`, so it can effectively move a card. But `POST /cards/{id}/move` is clearer in intent and what the skill uses for moves.

## `POST /cards/{id}/move`

**Path param:** `id` — card number.

**Body:**
```json
{
  "columnId": "{target_column_id}"
}
```

For mirror cards, also include `board` in the body.

## `POST /cards/{id}/comments`

Adds a comment to the card's activity log.

**Body:**
```json
{
  "text": "Moved to Proposal Sent — proposal emailed 14/04/2026"
}
```

The helper uses this endpoint for the standing "log the reason when you move a card" hygiene practice.

## What the API does NOT support

These operations still require the browser (see `references/browser-automation-tips.md`):

- **Checklists / tasks** — creating checklists, adding items, toggling items
- **Attachments** — uploading or deleting files

(Comments *are* supported via the API in v1.3, despite what older docs suggest.)

## Rate limiting and error handling

The spec doesn't document explicit rate limits; be polite. For batches, stagger calls (e.g., 200ms between writes for a loop of 20+ cards), and always use the array form of `POST /cards` for many-creates rather than one request per card.

Standard HTTP codes apply: 401 (bad key), 403 (no access), 404 (card/board not found), 422 (invalid field), 5xx (server). The API occasionally returns HTTP 200 with a plain-text error body like `"Bad Request"` or `"Unauthorized"` — the helper detects this and surfaces the status, Content-Type, URL, and first 500 chars of the body. On a write failure, re-read the card before retrying.
