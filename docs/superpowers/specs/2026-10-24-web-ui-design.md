# Web UI for the assistant (feature #153)

Cards: #241 shell + sign-in, #242 chat, #243 projects + history, #244 goals, #245 file tree, #246 settings, #247 update notice. Target version 1.48.0.

## Intent

A browser home for the assistant: chat, projects, goals and files in one place, for owners who want more than a Telegram thread. Web first, served by the box itself; later wrapped as the mobile app (#112), so the layout is phone-first and the API is a clean JSON/SSE surface an app can reuse.

Non-goals for this release: multi-user accounts (the web UI signs in as an allowed chat, same identity as Telegram), voice in the web UI (the voice pages already exist), editing files in the browser, a frontend build step.

Anti-goals: anything that weakens the box's security posture. A web UI that a stranger can reach, or that serves a secret file, is a failure even if every panel works.

## Decisions

Marc's: web UI now, standalone mobile app later. The "recommended additions" criterion is out of scope.

My calls (builder may refine, not reverse):

1. **No frontend framework, no bundler.** Plain HTML, CSS and ES-module JS under `public/app/` (index.html, app.css, app.js plus small modules). Matches the existing voice pages and ships through the existing `public/` payload path. No new npm dependencies.
2. **Served by the main HTTP server** (`src/http-server.ts`, port `HTTP_PORT`) at `/app` and `/app/*`; JSON/SSE API under `/api/web/*`. All new route code lives in `src/web/` with one dispatch hook in http-server.ts.
3. **Sign-in by one-time link from chat**, like `/voice ui`:
   - `/app` in an allowed chat mints a single-use link token (256-bit, 15 min).
   - The page POSTs it to `/api/web/session`, which exchanges it for a web session cookie `havn_web`.
   - The cookie is HttpOnly, SameSite=Strict, Path=/, Secure over TLS, valid 30 days and sliding.
   - Sessions are stored hashed (SHA-256) in a new `web_sessions` table with chat_id, created_at, expires_at, last_seen_at and a short user-agent label.
   - The link URL is `https://PUBLIC_HOSTNAME/app#token=...` when a public hostname is set, else `http://<LAN IP or localhost>:HTTP_PORT/app#token=...` (reuse `shortcutUrl`'s LAN logic). The token goes in the fragment so it never reaches logs or servers.
   - The page reads the fragment, clears it with `history.replaceState`, and POSTs it.
   - Signed out, or after a 401, the page shows a "Send /app to your assistant to get a sign-in link" screen and nothing else.
4. **Every `/api/web/*` route requires a valid web session**, with two exceptions: the exchange route, and nothing else. The box bearer token and voice cookies do NOT grant web access. The open-loopback mode does NOT apply. The chat id comes from the session, and `isChatAllowed(chatId)` is re-checked on every request, so revoking `/authorize` locks the web out too.
5. **CSRF and browser hardening** (from reference/security-playbooks: auth weaknesses, XSS, CORS, headers, rate limiting):
   - State-changing routes require `Content-Type: application/json` (uploads use `application/octet-stream` with a required custom header `X-Havn-Web: 1`).
   - When an `Origin` header is present, it must match the request host.
   - SameSite=Strict on the cookie.
   - No CORS for `/api/web/*`.
   - Headers on `/app*` and `/api/web/*`: CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store` on API responses.
   - No inline script or style anywhere in `public/app/`.
   - All assistant and user text is rendered by a small escaping markdown renderer: escape first, then format; links only http/https with `rel="noopener noreferrer" target="_blank"`. Never assign untrusted strings to innerHTML unescaped.
   - Exchange route rate limit: 10 attempts per IP per 10 minutes, in memory.
6. **Conversations are web-owned.**
   - A web chat is a conversation row (`web_conversations`: id, chat_id, project_id or '' for General, title, session_id, model, effort, created_at, updated_at) with its own agent session, separate from the Telegram session.
   - Messages are stored in full in `web_messages` (id, conversation_id, role 'user'|'assistant', content, files JSON, created_at). This is the chat history the UI lists. Telegram history is not shown; it is not stored anywhere.
   - Memory is shared: turns call `saveConversationTurn(chatId, ...)` and `contextEngine.buildContext(chatId, ...)` with the real chat id, so the assistant knows both surfaces.
   - Title is the first user message, trimmed to 60 chars.
7. **Turns go through the bot's existing turn queue.**
   - Add an exported `runWebTurn(input): Promise<WebTurnResult>` in src/bot.ts, modelled on `shortcutTurn`, keyed in the queue as `web:<conversationId>`. It accepts model, effort, onPartial, onToolProgress.
   - Add an exported `cancelWebTurn(conversationId)` wrapping `turnQueue.cancel('web:'+id)`.
   - The SSE response streams events: `queued` {ahead}, `delta` {text}, `tool` {name,status}, `done` {message}, `error` {message}, `paused` {text}. Deltas are computed from accumulated text.
   - A closed browser connection does NOT cancel the turn (the reply is still saved; the page reloads history). Only the Stop button cancels.
   - `aiPaused` results show the same owner pause text the bot uses, via the existing ai-limit helpers.
8. **Model and effort per conversation.**
   - Model picker: Default, Haiku, Sonnet, Opus (`'' | 'haiku' | 'sonnet' | 'opus'`).
   - Effort picker: Default, Low, Medium, High (`'' | 'low' | 'medium' | 'high'`).
   - Thread `model` and a new `effort?: 'low'|'medium'|'high'` through `runAgent` (new optional trailing options object, so existing callers are unchanged), into `AgentRunOptions.effort`, and pass `effort` to the Claude SDK `query()` options when set (SDK 0.2.141 supports it). The ai-sdk runtime ignores effort (documented).
   - Stored on the conversation and changeable at any time.
9. **Files the assistant sends back.**
   - Run `extractFileMarkers` on the reply and resolve each with `resolveOutboundFile`. Store the resolved relative path, name and kind in the message's files JSON.
   - Download via `GET /api/web/messages/:id/files/:index`, which re-resolves with the same rules at download time.
   - `[[buttons: ...]]` markers render as clickable buttons that send the label as the next message (same contract as Telegram's `[button_click]: <label>`).
10. **Projects** = `projects/**/STATE.md`, listed with name (frontmatter `name`, then `project`, then dir), company, status. Plus a fixed "General" entry. A new parser in src/web/, not ProjectProvider's private one. Each project lists its conversations, newest first, and a New chat button. Chats can be started in a project; the turn's message is prefixed with a one-line framing naming the project and its STATE.md path so the assistant works in that context.
11. **Goals** = the Priorities section of `PROFILE.md`, the same thing the briefing and audit read (one source of truth).
    - The parser finds the first heading matching `/^#+\s*priorit/i` and reads the bullet lines up to the next heading of the same or higher level. Bullets may be `- text`, `- [ ] text` or `- [x] text`.
    - The UI lists open goals, then done ones. Add appends `- [ ] text`, edit rewrites the text, done toggles the checkbox.
    - Writes rewrite only the bullet lines of that section, atomically (tmp + rename), and refuse if the file changed since it was read (an mtime/hash precondition sent by the client).
    - If PROFILE.md is missing or still the stub, or has no Priorities heading, the first add creates a `## Priorities` section at the end.
12. **File tree** is rooted at PROJECT_ROOT with a denylist, enforced server-side on every request.
    - Hidden directories: `.git node_modules dist store src scripts tests templates deploy coverage public .claude`.
    - Every dotfile and dot-directory is hidden.
    - Hidden files: `roles.json`, plus anything matching the outbound-files `NEVER_SEND` patterns (export that constant).
    - Paths are resolved with realpath and must stay inside PROJECT_ROOT. Symlinks that escape are hidden.
    - Lazy listing per directory, `GET /api/web/files?path=`.
    - Preview through `GET /api/web/files/raw?path=`: text and markdown up to 1 MB as text, images inline, PDF in an iframe; everything else download only. Responses carry `Content-Disposition` and the right MIME type, with `nosniff`.
    - Uploads: `POST /api/web/files/upload?name=` writes to `workspace/uploads/` (the existing UPLOADS_DIR), 25 MB cap, with a sanitised name and no overwrite (suffix -1, -2).
13. **Settings** panel:
    - Connections from a new `getConnections()` in src/web/connections.ts, which composes existing pieces:
      - Model provider: `credentialStatus()`
      - Telegram: bot token set
      - Gmail accounts: `gog auth list`, guarded and cached for 5 min, and only if gog exists
      - Outlook: `listAuthedAccounts()`
      - IMAP: `listAccounts()`
      - Voice: `voiceCapabilities()`
      - Shortcut: `shortcutTokenInfo`
      - Managed AI: `isManagedAi()`, plus month usage from ai-usage
    - Each connection has a status of connected, needs attention, or off, plus a plain-language next step for anything that is not connected. A "Check now" button runs `discoverMailboxes()` and marks broken mailboxes as needing attention.
    - Signed-in devices: list and sign out others.
14. **Update notice**: `GET /api/web/status` returns version, `checkForUpdate(true)`, `restartPending()`. The banner shows "Version X is available. Send /update to your assistant to install it." (or "restart pending"). Dismiss stores the dismissed version in `app_state` key `web.update.dismissed`, and the banner comes back only for a newer version.
15. **Hosted edge**: `buildCaddyfile` gets a `web` option adding matchers `/app /app/ /app/* /api/web/*`. `enable-teams` gets `--web`. Docs in `docs/WEB-UI.md` (user-facing) plus a CHANGELOG 1.48.0 entry. The `/app` chat command explains how to enable the hosted edge when PUBLIC_HOSTNAME is unset on a hosted box, exactly like `/voice ui` does.

## Layout

Three areas:

- **Left panel:** Projects with their chats, then Goals, then a Settings button.
- **Centre:** the chat, with model and effort pickers in its header, a Stop button while a turn runs, and a message composer.
- **Right panel:** the file tree and preview.

On screens under 900px the side panels become slide-over drawers opened from header buttons, and the chat is full width. The update banner sits on top of the centre. Theme follows the system, light or dark, via CSS variables.

## Left to the builder

Visual styling details, exact module split of public/app JS, SSE framing helper shape, test file names.
