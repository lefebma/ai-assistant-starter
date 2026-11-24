# Google Drive in the files panel, slice 1 (card #284)

Status: draft for Marc's approval, 2026-11-23. Builder check done.

## Intent

The web app's right panel shows only the assistant's own files. Marina wants to
browse her Google Drive there (raised on the Nov 5 call). This slice gives the
panel a source switcher and a read-only Google Drive view. It is the first of
four slices: (1) switcher and Drive browsing, (2) split view, (3) pulling a
Drive file into a project, (4) OneDrive.

## Goals

- A source switcher on the files panel: "Havn files" (today's tree) and one
  entry per connected Google Drive account.
- Browse Drive folders and files, read only. Open a file to preview it in the
  panel's existing preview pane, or download it.
- Drive is its own connection. Nobody is asked for Drive access until they
  choose Google Drive in the switcher.
- Works on hosted boxes (one-tap sign-in through the relay) and self-installed
  boxes (`gog` sign-in).
- The source list is a small registry on both server and page, so OneDrive is
  added later as one more source without reworking the panel.

## Non-goals (this slice)

- Split view, draggable divider, remembered layouts (slice 2).
- Pulling a Drive file into a project or a chat (slice 3).
- OneDrive (slice 4).
- Search. Shared drives. "Shared with me". Only "My Drive" is browsed.
- Any write to Drive: no upload, rename, move, delete.
- Telling the assistant about Drive. No skill, prompt or tool is added.
- The Umi port. It follows as its own change once this is merged (parity rule).

## Anti-goals

- A mail-only user sees a Drive consent line.
- The panel can change or delete anything in Drive.
- A Drive token, file id or file name reaches the log.
- Drive file content is sent to a model by this feature.
- A chat other than the owner's main chat can list or read Drive.
- Disconnecting Drive silently breaks that account's Gmail.

## Constraints

- Permission: `https://www.googleapis.com/auth/drive.readonly` (Marc's
  decision). The Havn Google app is published unverified; this scope is
  restricted and joins the later security assessment.
- The relay's Google client secret never reaches a box. Renewal goes through
  the relay's `/refresh`, as for Gmail.
- The relay's sealing binds a refresh token to `box:provider`, so Drive needs
  its own provider key.
- No em dashes in user-facing copy. Plain language.
- VERSION and CHANGELOG are bumped in the PR (a minor version).

## Approaches

1. **Drive as its own connection (chosen by Marc).** A third relay provider,
   `drive`, asking for `openid email drive.readonly` only. Its tokens are kept
   apart from Gmail's. The switcher offers Connect the first time. Mail-only
   users never see the Drive line; on hosted boxes the assistant's tools never
   hold a Drive token.
2. **Add Drive to the Gmail connection.** One grant, less code. Rejected: every
   mail connection would show "See and download all your Google Drive files",
   and the assistant's Google tool would get Drive on every box, which widens
   what a hostile email could make it read.
3. **A direct Drive REST client in the box.** Rejected: a self-installed box
   signs in through `gog` with gog's own OAuth client, so a direct client would
   need a second code path for those accounts. Calling `gog` covers both.

## Design

### 1. Connection

**Relay (`src/connect/providers.ts`, `src/connect/relay.ts`, `deploy/connect-relay/worker.ts`).**
`googleProvider` takes its scope list as a parameter. The worker registers a
second Google provider under the key `drive` with
`['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']`, same
client id and secret. `gmail` keeps its scopes unchanged. The auth URL for
`drive` does not set `include_granted_scopes`, so the Drive token carries only
Drive.

The relay's confirmation page (`relay.ts`, the page every sign-in passes
through, and a security control against forwarded links) hard-codes mail and
calendar wording for every provider. `RelayProvider` gains a per-provider
description so each page says what is being granted. Gmail and Outlook keep
today's words exactly. Drive reads: heading "Connect your Google Drive"; body
"This lets <box label> see and download the files in your Google Drive. It
cannot change them."; the warning line becomes "Continuing would give them
your files"; the closing page says "Go back to Havn. Your Drive files will
appear in the files panel." (Claude's wording; Marc to confirm.)

**Box (`src/connect/box.ts`, new `src/connect/drive-token.ts`).**
- `/connect drive` starts a sign-in exactly as `/connect gmail` does. It is
  listed in the usage text and in `/connect list` (`drive: <account>`).
- The hand-off for provider `drive` saves an entry under a new vault name,
  `CONNECT_DRIVE`, in the same per-account shape as Gmail entries. It does not
  touch IMAP entries. The chat notice reads: "Connected <account>. Google Drive
  is now in the files panel, read only."
- A Drive keeper renews the access tokens through the relay like the Gmail
  keeper (same renew-before window and tick). The shared logic in
  `gmail-token.ts` is reused by parameter (vault entry name, relay provider),
  not copied. Drive tokens are **not** put in `GOG_RELAY_TOKENS` or any
  environment variable; they are read from the keeper when a Drive call is
  made.
- Revoked at Google: the entry is marked revoked, the owner is told once
  ("Google Drive access for <account> was withdrawn at Google. Open the files
  panel and connect again."), and the switcher shows that account as needing a
  reconnect.
- **One grant per Google account.** Gmail and Drive share one client id, and
  revoking any refresh token ends the whole grant (`providers.ts`, the comment
  on `revoke`). So:
  - `/connect remove drive <account>` is local only: it drops the entry and
    never calls the relay's `/revoke`. The reply: "Removed Google Drive for
    <account> from this box. To withdraw the permission at Google, remove Havn
    under myaccount.google.com/connections; that also disconnects its Gmail."
  - `/connect remove gmail <account>` keeps revoking at Google as today. When a
    Drive entry exists for the same address it is dropped in the same step and
    the reply adds: "This also disconnected Google Drive for that account."
    (Claude's call: say so, rather than let Drive fail five minutes later.)
  - The live check confirms both directions against real Google.

**Self-installed box.** There is no relay. The owner runs, once per account:
`gog auth add <account> --services gmail,calendar,drive --drive-scope readonly --gmail-scope send --extra-scopes https://www.googleapis.com/auth/gmail.modify`
(the existing mail command with Drive added, so mail keeps working). The setup
guide, `docs/SETUP-GUIDE.md` and the gmail skill's connect text gain this as an
optional line. On such a box the assistant's own `gog` can also reach Drive;
that is stated in the guide. No skill mentions it.

**Which accounts have Drive.** A new `driveAccounts()` returns, without calling
Google on every request:
- a box with the relay configured: the live `CONNECT_DRIVE` entries only.
  Accounts signed in through `gog` on such a box are ignored, even if their
  sign-in includes Drive, so Drive never appears without the Connect step.
  `connect` is `relay`.
- a box without the relay: accounts from `gog auth list --json` whose listed
  services include drive (cached five minutes with the existing
  `cachedCheck`). `connect` is `gog`.

### 2. Reading Drive (`src/web/drive.ts`, new)

One module wraps the real `gog` binary, not the account shim (`resolveGogBin`
returns the shim once installed, so the real path that `setUpGogShim` computes
gets an accessor), with `execFile`,
never a shell. Every call passes `--readonly`, `--json` and
`--enable-commands-exact` naming the one command in use.
- Relay account: the access token goes in the child's `GOG_ACCESS_TOKEN`
  environment variable, never on the command line.
- `gog` account: `--account <account>`.

Functions:
- `listFolder(account, folderId | 'root', pageToken?)` -> `{ entries, nextPage }`
  via `gog drive ls --parent <id> --max 100 [--page <token>]`. Each entry:
  `{ id, name, isDir, mimeType, size?, modified? }`. My Drive only
  (`--no-all-drives`), trashed files left out and folders first then names
  (through `--query`/ordering flags if the defaults do not already do so; the
  builder checks against real output). `--results-only` is not used, since it
  drops the next-page token.
- `getFile(account, fileId)` -> metadata via `gog drive get`.
- `fetchFile(account, fileId)` -> a temp file path plus the name and type to
  serve. Google Docs, Sheets and Slides are exported as PDF
  (`gog drive download --format pdf`); other Google-native types (Forms, Sites,
  shortcuts and the like) are "no preview". Everything else is downloaded as it
  is.

Limits: 25 MB per fetched file (checked from metadata before downloading;
larger files answer `too_large` and the page offers "Open in Google Drive"); a
30 second timeout per call; at most two Drive calls in flight per box (a third
waits). Downloads land in `store/drive-tmp/` under a random name, are streamed
to the browser and deleted in a `finally`; each request also deletes leftovers
older than ten minutes.

Ids from the browser are validated as Drive ids (`^[A-Za-z0-9_-]{1,128}$`, or
the word `root`) before they reach an argument list. The account must be one
`driveAccounts()` returned.

Before relying on it, the builder confirms that `--readonly` still lets a
`gog`-signed account renew its own token; if it does not, the `gog` path drops
`--readonly` and keeps `--enable-commands-exact` plus the read-only scope.

Errors are mapped to a small set the page can explain: `not_connected`,
`reconnect` (revoked or scope missing), `not_found`, `too_large`,
`unavailable` (timeout, Google error, `gog` missing).

### 3. Routes (`src/web/source-routes.ts`, new)

All need the web session and are **main chat only**: any other signed-in chat
gets 404 for every Drive route, and the switcher is not shown to it.

- `GET /api/web/sources` -> `{ sources: [{ id: 'local', name: 'Havn files' },
  { id: 'drive:<account>', name: 'Google Drive', account, state: 'ok' |
  'reconnect' }], canConnectDrive: boolean, connect: 'relay' | 'gog' | null }`.
  `canConnectDrive` is true when the box has a relay configured or `gog`
  installed.
- `GET /api/web/sources/drive/list?account=&folder=&page=` -> `listFolder`.
- `GET /api/web/sources/drive/raw?account=&id=` -> the file, with the same
  response headers the local `/api/web/files/raw` uses for its type (inline
  for images, PDFs and small text; attachment otherwise; `nosniff`; the PDF
  frame rule). The local route decides by file extension, on server and page.
  That logic is refactored to a "kind" (image, pdf, text, markdown, other)
  that the local route derives from the extension and the Drive route from
  the mime type, so both share the header and preview code. Local behaviour
  must not change; its existing tests stay green untouched.
- `POST /api/web/sources/drive/connect` -> on a relay box, starts a sign-in
  for the main chat and returns `{ url }` (the same one-time relay link
  `/connect drive` gives); on a `gog` box returns `{ command }`, the line to
  run. Needs the JSON content type like other POSTs.

The source registry is a list of `{ id prefix, list, raw }` handlers in one
file, so OneDrive is a new entry.

### 4. Page (`public/app/app.js`, `app.css`, `index.html`)

- A source picker (a `select`, styled like the panel's other controls) at the
  top of the files panel, shown only when `/api/web/sources` returns more than
  the local source or `canConnectDrive` is true. Entries: "Havn files", one
  "Google Drive (<account>)" per account (the account is left out when there
  is only one), and, when no Drive is connected and it can be, "Google Drive".
- Choosing an unconnected "Google Drive" shows, in place of the tree, one
  sentence and a button: "See your Google Drive files here, read only. Havn
  asks Google for permission to view them." [Connect Google Drive]. On a relay
  box the button opens the sign-in link in a new tab and the panel checks
  `/api/web/sources` every five seconds for up to ten minutes, then switches to
  the Drive tree. On a `gog` box it shows the command to run instead.
- The Drive tree reuses the tree code: folders expand lazily; a folder with
  more than a page ends with a "Show more" row that loads the next page. Rows
  carry the Drive id where local rows carry a path.
- Preview reuses the preview pane. Type is decided from the entry's mime type,
  not its name. Google Docs, Sheets and Slides show as PDF. "Download" saves
  what the preview shows (the PDF for a Google file). A second link, "Open in
  Google Drive", goes to `https://drive.google.com/open?id=<id>` in a new tab.
- The chosen source is remembered in `localStorage` (a convenience only; a
  missing or stale value falls back to Havn files). Uploads (the chat box's
  attachment tray, the project dialog) are unchanged and always go to Havn
  files.
- A source in the `reconnect` state shows the Connect view with: "Google Drive
  needs to be connected again."
- Refresh reloads the current source.

### 5. Privacy, security, logging

- Read only is enforced twice: the scope and `gog --readonly`.
- Logs record the event and counts only (`drive list`, entries: n, ok/failed).
  Never tokens, ids, names or the account's files. Access and refresh tokens
  are registered with the log redactor as Gmail's are.
- Nothing here calls a model, so the privacy filter has nothing to mask. File
  content goes from Google to the box to the owner's browser.
- The egress allowlist already admits Google's API hosts for mail; the builder
  confirms a Drive download from a box with egress enforced (havn-test) and
  adds the host if one is missing.
- Settings > Connections lists "Google Drive" with the connected accounts.

### 6. Tests

Unit tests with a fake `gog` runner and a fake relay fetch:
- provider: the `drive` auth URL carries only the three scopes; `gmail` is
  unchanged.
- relay page: Drive wording for `drive`; Gmail and Outlook pages unchanged.
- box: `/connect drive` link; hand-off saves under `CONNECT_DRIVE` and leaves
  Gmail and IMAP entries alone; list; Drive remove is local only and never
  calls `/revoke`; Gmail remove drops the same address's Drive entry and says
  so; revoked notice sent once.
- keeper: renews through the relay; tokens never appear in `process.env`.
- drive module: argument lists (read-only flags, exact command, token in env
  not argv); id and account validation refuses bad input before `gog` runs;
  paging; export of Google files to PDF; 25 MB refusal; temp file removed on
  success, on failure and on a client that disconnects; leftovers swept.
- routes: 401 without a session; 404 for a non-main chat; error mapping;
  response headers per type.
- page: source picker visibility rules; Connect view; "Show more"; stale
  remembered source falls back.

A live check on havn-test before the card moves to Verify: connect Drive
through the relay, browse two levels, preview a Google Doc, an image and a
PDF, refuse a file over 25 MB, remove Drive (Gmail keeps working), then
remove Gmail with Drive connected (both go, and the reply says so).

## Outside the code (Marc)

- Add `drive.readonly` to the consent screen scopes in the `havn-assistant`
  Google project, and make sure the Drive API is enabled there (it was in
  October).
- OK a redeploy of the connect relay Worker with the new provider. The relay
  change is backwards compatible, so it can go out before the box release.
- OK the havn-test update for the live check.

## Left to the builder

- Module boundaries inside `src/connect` when sharing the keeper.
- Exact `gog` JSON field names (read them from `gog drive ls --json` output).
- Styling of the picker and the Connect view, within the panel's existing look.
- Whether the two-in-flight limit is a tiny queue or a counter with a wait.

## As built (2026-11-23)

Where the build differs from the design above, or settles something it left open:

- Removing Gmail drops that address's Drive entry only when the Google revoke
  succeeded. It does not drop it for `--local-only`, when no revoker is
  available, or when the revoke fails. In those cases Drive stays connected.
- `gog` exit code 4 is answered as "reconnect" and exit code 5 as "not found".
  Ids and page tokens that start with `-` are refused before `gog` runs.
- The user-facing docs (changelog, setup guide, hosted guide, Gmail skill
  connect line, `/help` and one tip) describe the `gog auth add ... --services
  gmail,calendar,drive --drive-scope readonly` line for self-installed
  assistants. The skill gains no Drive instructions.

Not yet verified against real Google (for the live check):

- That `gog` accepts `--` before a positional id.
- The real JSON field names of `gog drive ls` and `gog drive get` with
  `--json` and `--fields`.
- That `--readonly` still lets a gog-signed account renew its token.
- What a Google revoke of one token does to the other grant (Gmail and Drive),
  in both directions.
