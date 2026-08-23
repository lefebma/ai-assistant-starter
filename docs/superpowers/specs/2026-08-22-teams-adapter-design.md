# Microsoft Teams platform adapter — design

Date: 2026-08-22. Status: approved design, pre-implementation. Kanban: Havn
board #104 (build), #100 (validate on a hosted box). Pilot-critical for the
law-firm deal (projects/els-partners/marina-lawfirm).

## Goal

A Havn install can use Microsoft Teams as its chat surface instead of
Telegram or Slack, with the same bot behaviour the other adapters deliver:
text in and out, typing indicator, streaming preview edits, `[[buttons]]`
approval flows, and files the user sends. Validated on a hosted VPS box.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Bot topology | One Azure Bot + one Teams app **per install** | Pricing and the runtime are per install; mirrors Telegram/Slack; no shared infrastructure; ELS never in the message path. A firm-wide bot with a relay is a later card if 30 users materialise. |
| Inbound path | **Caddy on the box, port 443**, hostname via sslip.io or an owned subdomain | No new accounts or domains. Only `/api/teams/*` is proxied. Laptop installs would need a tunnel; out of scope. |
| Implementation | **Hand-rolled Bot Connector REST + `jose`** for JWT | Protocol surface is small and stable; one audited dependency; matches the repo's style. Microsoft 365 Agents SDK is the fallback if the REST surface surprises us. |
| Registration tenant | Marc's Entra tenant, **multi-tenant** registration for the pilot; `TEAMS_TENANT_ID` optional for a firm that registers single-tenant in its own tenant | Fastest path to validation; keeps the governance door open. |
| v1 scope | 1:1 personal chat: text/Markdown, typing, edit-streaming, buttons (Adaptive Cards), inbound documents and images | Enough to prove Teams to Marina. Voice, outbound files, channels, laptop installs, relay: out. |

## Architecture

### New module `src/platform/teams/`

- `adapter.ts` — `TeamsAdapter implements PlatformAdapter`. `name = 'teams'`,
  `maxMessageLength = 8000`, `supportsEdit = true`, `supportsButtons = true`.
  `start()` registers the inbound route; `stop()` unregisters it and drops
  the token cache.
- `auth.ts` — inbound JWT validation and outbound token acquisition.
  - Inbound: verify with `jose` against the JWKS published at
    `https://login.botframework.com/v1/.well-known/openidconfiguration`
    (fetch `jwks_uri` from it). Required: issuer `https://api.botframework.com`,
    audience = `TEAMS_APP_ID`, `exp` in the future (60 s leeway), `kid`
    present in the key set. Key set cached; on an unknown `kid` refetch once
    (rotation), then reject.
  - Outbound: client-credentials grant against
    `https://login.microsoftonline.com/{tenant|botframework.com}/oauth2/v2.0/token`
    with scope `https://api.botframework.com/.default`. Cached; refreshed
    when under 5 minutes from expiry.
  - Both take `fetch` and `now()` as parameters so tests inject fakes.
- `connector.ts` — REST client over a conversation reference:
  `sendActivity`, `updateActivity`, `deleteActivity`, `sendTyping`. Base
  `{serviceUrl}/v3/conversations/{conversationId}/activities[/{activityId}]`.
  Retry policy: 401 → refresh token once and retry; 429 → honour
  `Retry-After` once; 5xx → one retry after 1 s; otherwise throw.
- `activities.ts` — pure mappers, no I/O. Inbound Activity →
  `IncomingMessage | null`; outbound builders for text, Adaptive Card with
  buttons, cleared card (plain text), typing.
- `conversations.ts` — conversation-reference store. New SQLite table
  `teams_conversations(conversation_id PK, service_url, bot_id, user_id,
  tenant_id, updated_at)`. Upsert on every inbound activity; read for every
  outbound call. Proactive sends (scheduled tasks, briefings) depend on it.

### HTTP seam

`src/http-server.ts` gains:

```ts
export function registerHttpRoute(method: string, path: string, handler: RouteHandler): () => void
```

Registered routes are matched before the existing if-chain and are **exempt
from the `HTTP_BEARER_TOKEN` check** (the Teams route authenticates with the
Bot Framework JWT). Registration is order-independent: the adapter registers
during `createAdapter()`/`start()`, which runs before `startHttpServer()`.
`TeamsAdapter.start()` registers `POST /api/teams/messages`.

### Edge on the box

`scripts/hosted/enable-teams.sh <hostname>` (run as root over SSH once the
server exists; the sslip.io name depends on the IP, so this cannot live in
cloud-init):

1. `apt-get install -y caddy` (Ubuntu 24.04 universe).
2. Write `/etc/caddy/Caddyfile`:
   ```
   <hostname> {
     handle /api/teams/* {
       reverse_proxy 127.0.0.1:3030
     }
     handle {
       respond 404
     }
   }
   ```
3. `ufw allow 80/tcp` (ACME HTTP-01) and `ufw allow 443/tcp`.
4. `systemctl enable --now caddy`; print the messaging endpoint
   `https://<hostname>/api/teams/messages`.

Cockpit, voice, and every other route stay reachable only on the box.

### Platform wiring

`createAdapter()` builds `TeamsAdapter({ appId, appSecret, tenantId? })`
from `TEAMS_APP_ID`, `TEAMS_APP_SECRET`, optional `TEAMS_TENANT_ID`.
`detectPlatform()` also auto-detects `teams` when both `TEAMS_APP_ID` and
`TEAMS_APP_SECRET` are set and no `PLATFORM` is given. The polling watchdog
in `src/index.ts` is already gated to `platform === 'telegram'`; Teams is
push-based and needs no change there.

### Dependencies

`jose` (JWT/JWKS). Nothing else.

## Data flow

### Inbound

`POST /api/teams/messages`:

1. Reject bodies over 1 MB (413). Read JSON.
2. Validate the `Authorization: Bearer` JWT. Failure → 401, empty body,
   logged at most once per minute.
3. Respond `200` immediately, then process asynchronously. Teams expects a
   response within 15 s and our agent turns run longer. Any error after the
   200 is logged with the activity id and not retried.
4. Dedupe on `activity.id` with the existing `processed_updates` table.
5. Upsert the conversation reference.
6. Map by `activity.type`:
   - `message` with `value.btn` (a `messageBack` click) →
     `{ type: 'callback', callbackData: 'btn:<label>', messageId: activity.replyToId }`
     so the existing click path runs unchanged.
   - `message` with attachments → download to the media dir, then
     `type: 'document' | 'photo'` with `filePath`, `fileName`, `caption`.
     Teams file attachments (`application/vnd.microsoft.teams.file.download.info`)
     carry a pre-authorised `content.downloadUrl`; inline images
     (`image/*` with `contentUrl`) need the bot token.
   - `message` with text → `{ type: 'text', chatId: conversation.id,
     userId: from.aadObjectId, text, messageId: activity.id, updateId: activity.id }`.
   - `conversationUpdate` where `membersAdded` includes the bot → store the
     reference and send the same "send /chatid to finish setup" hint an
     unauthorised Telegram chat receives.
   - `invoke`, `messageReaction`, `typing`, anything else → ignored.

`chatId` is the Teams conversation id (stable per user–bot pair in personal
scope). `ALLOWED_CHAT_ID` holds it; `/chatid` reports it. Authorisation in
`src/access.ts` is unchanged.

### Outbound

- `sendMessage(chatId, text, opts)`: POST a `message` activity.
  `parseMode: 'markdown'` passes through; `formatText` maps the bot's
  HTML/Markdown to Teams' Markdown subset (bold, italic, inline code, code
  blocks, links, lists). With `opts.buttons`, the activity carries one
  Adaptive Card (`version 1.4`) whose body is the text and whose actions are
  one `Action.Submit` per label with
  `data: { msteams: { type: 'messageBack', text: label, displayText: label, value: { btn: label } } }`.
  Returns the activity id.
- `editMessage`: PUT the activity. Throttled to one edit per second per
  conversation; intermediate edits are coalesced, the last one always lands.
- `sendTyping`: POST a `typing` activity.
- `clearButtons(chatId, messageId)`: PUT the activity as plain text with the
  card's original body, so the buttons vanish like Telegram's keyboard.
- `answerCallback`: no-op (messageBack has no callback to answer).
- `sendFile`: v1 sends a one-line note ("saved on the assistant's machine
  as <name>"); outbound files need Teams' file-consent flow, a later card.
- `deleteMessage`: returns `false`. Bots cannot delete a user's message;
  the `/secret` flow already tells the user to delete it themselves when
  `false` comes back.
- `splitMessage`: split on paragraph boundaries at 8000 chars.

## Configuration, registration, onboarding

### `.env`

```
PLATFORM=teams
TEAMS_APP_ID=
TEAMS_APP_SECRET=
TEAMS_TENANT_ID=          # optional; omit for a multi-tenant registration
ALLOWED_CHAT_ID=          # the Teams conversation id from /chatid
```

`src/setup/plan.ts` already writes the three `TEAMS_*` keys for the Teams
choice; `scripts/setup.ts` gains the same "paste now or fill in later"
prompts Telegram has. `/secret set TEAMS_APP_SECRET` handles rotation on a
hosted box.

### Registration

`scripts/teams-register.sh <name> <hostname> [--tenant <id>] [--resource-group havn-bots]`
using the `az` CLI (authenticated once by the operator):

1. `az ad app create` — display name "Havn – <name>", sign-in audience
   `AzureADMultipleOrgs` (or `AzureADMyOrg` with `--tenant`).
2. `az ad app credential reset` — client secret, 24-month expiry. Printed
   once; the operator pastes it into `.env` (or `/secret set`).
3. `az bot create --kind azurebot --sku F0 --app-type MultiTenant|SingleTenant --endpoint https://<hostname>/api/teams/messages`.
4. `az bot msteams create` — enable the Teams channel.
5. Print `TEAMS_APP_ID`, `TEAMS_APP_SECRET`, `TEAMS_TENANT_ID` lines.

Idempotent by name: re-running finds the existing app and bot and only
re-prints (secret reset only with `--rotate-secret`).

### Teams app package

`npm run teams-manifest -- --app-id <id> --name "<assistant>" [--out path]`
renders `deploy/teams/manifest.json.template` (schema 1.16, `bots[0].scopes
= ["personal"]`, no additional permissions, `validDomains` empty) plus the
two icons (`deploy/teams/color.png`, `deploy/teams/outline.png`) into
`deploy/rendered/<name>-teams.zip`. The user installs it in Teams → Apps →
Manage your apps → Upload a custom app. If the tenant blocks custom uploads,
the Teams admin publishes it to the org catalog; both paths in the runbook.

### Docs

- `docs/HOSTED-VPS.md`: new section "Teams instead of Telegram": run
  `enable-teams.sh`, register, render the package, install, send anything,
  `/chatid`, set `ALLOWED_CHAT_ID`, restart. Security-posture bullet updated:
  80/443 open, only `/api/teams/*` proxied, JWT-gated.
- `docs/SETUP-GUIDE.md`: the Teams section (currently points at Power
  Automate) rewritten to match.
- `CHANGELOG.md` Unreleased: "New: Microsoft Teams as a chat surface".

## Errors and security

- Inbound: missing/invalid JWT → 401; wrong audience → 401; body > 1 MB →
  413; malformed JSON → 400. Logging of auth failures rate-limited (one
  line per minute with a count).
- Outbound: retry policy in `connector.ts` (above). Failures propagate like
  Telegram send failures; the bot logs and continues.
- Replay: `processed_updates` on `activity.id`, 7-day window as today.
- Edge: Caddy proxies only `/api/teams/*`, 404 elsewhere; ufw 80/443 only;
  3030 never exposed. Certificates are Caddy's responsibility.
- Secrets: `TEAMS_APP_SECRET` in `.env` only, never logged. Expiry (24
  months from registration) is a dated item in the runbook, like the OAuth
  token.
- Playbooks: `reference/security-playbooks/` entries for API authorisation
  and supply chain are read at plan time; the tester verifies against them.

## Testing

### Unit (no network)

- `auth.ts`: a key pair generated in the test signs tokens; valid token
  accepted; wrong issuer, wrong audience, expired, unknown `kid` rejected;
  unknown `kid` triggers exactly one JWKS refetch; outbound token cached and
  refreshed under 5 minutes to expiry.
- `activities.ts`: mapping for text, messageBack click, file attachment,
  inline image, conversationUpdate (bot added / someone else added), ignored
  types; outbound builders produce the documented shapes.
- `connector.ts`: retry policy with a fake fetch (401 → refresh → retry;
  429 with Retry-After; 5xx once; 4xx throws).
- `adapter.ts`: edit throttle coalesces and always lands the last edit;
  `splitMessage` at boundaries; `formatText` subset.
- `conversations.ts`: upsert/read round-trip on a temp database.
- `http-server.ts`: `registerHttpRoute` matches before the chain, bypasses
  the bearer check, and unregisters.

### Integration (in-process)

A fake Bot Connector (`node:http`) stands in for `serviceUrl`. Start the real
HTTP server on a random port, POST a signed activity to
`/api/teams/messages`, assert: 200 returns before the handler resolves; the
reply is POSTed to the fake with the expected body; a bad signature gets 401
and nothing reaches the fake; a duplicate activity id is processed once.

### Verification

Typecheck, build, full vitest, playbook check, before the PR.

### Live validation (card #100, exit criterion for #104)

On `havn-test`: register a bot under Marc's tenant, `enable-teams.sh`,
sideload the package into Marc's Teams, switch Nami to `PLATFORM=teams`,
then exercise: plain text, a scheduled proactive message, a `[[buttons]]`
approval, a dropped PDF, a pasted image, `/secret set` round trip, a service
restart mid-conversation (reference survives), and a token rotation.

## Out of scope (separate cards if wanted)

Voice notes; sending files to the user; group/channel scope; laptop installs
(tunnel); firm-wide bot with relay; Teams SSO / Graph access on behalf of the
user (the M365 mail/calendar gap is its own item).
