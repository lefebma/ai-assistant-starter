# Google Drive in the Files Panel (slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app's files panel gets a source switcher and a read-only Google Drive view, with Drive as its own connection.

**Architecture:** A third relay provider `drive` (Google, `drive.readonly` only) hands the box a token kept in its own vault entry and renewed by its own keeper, never placed in the environment. A box-side module shells out to the real `gog` binary in read-only mode to list, inspect and fetch Drive files. New main-chat-only web routes expose a source registry; the page adds a picker, a Connect view and a Drive tree that reuse the existing tree and preview code through a shared "kind" abstraction.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, plain browser ES modules in `public/app/`, Cloudflare Worker for the relay, `gog` CLI v0.39+.

**Spec:** `docs/superpowers/specs/2026-11-23-drive-files-panel-design.md`

## Global Constraints

- Run everything with Node 22: `export PATH=/usr/local/bin:$PATH`.
- Scope is exactly `https://www.googleapis.com/auth/drive.readonly`; the `drive` provider's scopes are `['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']`. `gmail` scopes do not change.
- Drive tokens never enter `process.env`, `GOG_RELAY_TOKENS`, a command line, or a log. Logs carry event names and counts only: no ids, names, accounts' file data.
- Every Drive route is main chat only: any other signed-in chat gets 404.
- Read only: no code path may call a mutating `gog drive` command.
- User-facing copy: plain language, no em dashes. Copy given in quotes in the spec or this plan is used verbatim.
- Local file panel behaviour must not change; existing tests stay green without edits (except where a task says a test file is extended).
- Limits: 25 MB per fetched file; 30 s per `gog` call; 2 Drive calls in flight per box; 100 entries per page; temp files in `store/drive-tmp/`, leftovers older than 10 minutes swept on each request.
- Never `git add -A`; add files by path. Commit messages end with the two attribution lines used on this branch's first commit.
- Out of scope: split view, pulling into projects, OneDrive, search, shared drives, the Umi port.

## Review Focus

1. **A Google file whose name has no extension, or has `/` or quotes in it** is previewed and downloaded with a safe name ending in `.pdf`. (Task 4 and Task 5 tests.)
2. **The Drive token expires or is revoked while the panel is open**: the next list answers `reconnect` and the page shows the Connect view, not a spinner or a raw error. (Task 4, Task 6, Task 7 tests.)
3. **The remembered source names an account that is no longer connected**: the page falls back to Havn files without an error. (Task 7 test.)
4. **An empty Drive folder and a folder with exactly one full page**: "Empty" for the first; "Show more" for the second only when a next-page token came back. (Task 4 and Task 7 tests.)
5. **`gog` is missing or times out on a relay box**: routes answer `unavailable`, the page says "Google Drive is not available right now. Try again in a minute." and Havn files still work. (Task 4, Task 6 tests.)

---

### Task 1: Relay provider `drive` and per-provider confirmation copy

**Files:**
- Modify: `src/connect/providers.ts`, `src/connect/relay.ts`, `deploy/connect-relay/worker.ts`, `deploy/connect-relay/README.md`
- Test: `tests/connect-providers.test.ts`, `tests/connect-relay.test.ts`, `tests/connect-relay-worker.test.ts`

**Interfaces:**
- Produces:
  - `export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']`
  - `googleProvider(app: OAuthApp, fetchImpl?, now?, opts?: { scopes?: string[]; copy?: ProviderCopy }): RelayProvider` (defaults: `GOOGLE_SCOPES`, mail copy)
  - `export interface ProviderCopy { heading: string; grant: string; risk: string; done: string }` on `RelayProvider` as optional `copy`. `heading`/`grant`/`risk`/`done` may contain `{label}` (provider label) and `{who}` (box label), substituted and HTML-escaped by `relay.ts`.
  - Worker registers `out.drive` whenever `out.gmail` is registered.

- [ ] **Step 1: Write the failing tests**

In `tests/connect-providers.test.ts`:
```ts
it('the drive provider asks for Drive read access and nothing else', () => {
  const u = new URL(googleProvider({ clientId: 'cid', clientSecret: 'S' }, undefined, undefined, { scopes: DRIVE_SCOPES }).authUrl('ST', 'https://r/callback', 'CH'))
  expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.readonly')
  expect(u.searchParams.has('include_granted_scopes')).toBe(false)
})
it('the gmail provider still asks for mail and calendar only', () => {
  const u = new URL(googleProvider({ clientId: 'cid', clientSecret: 'S' }).authUrl('ST', 'https://r/callback', 'CH'))
  expect(u.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '))
  expect(u.searchParams.get('scope')).not.toContain('drive')
})
```
In `tests/connect-relay.test.ts` (use the file's existing relay fixture; add a `drive` provider with Drive copy):
```ts
it('the Drive confirmation page says Drive, not mail', async () => {
  const body = await (await startPage('drive')).text()
  expect(body).toContain('Connect your Google Drive')
  expect(body).toContain('see and download the files in your Google Drive. It cannot change them.')
  expect(body).toContain('Continuing would give them your files.')
  expect(body).not.toContain('mail')
})
it('the Gmail confirmation page is unchanged', async () => {
  const body = await (await startPage('gmail')).text()
  expect(body).toContain('Connect your Google mail and calendar')
  expect(body).toContain('access to read and send your email and manage your calendar.')
  expect(body).toContain('Continuing would give them your mail.')
})
it('the Drive closing page points back to the files panel', async () => {
  expect(await finishedPageText('drive')).toContain('Go back to Havn. Your Drive files will appear in the files panel.')
})
```
In `tests/connect-relay-worker.test.ts`:
```ts
it('registers drive beside gmail when the Google app is configured', () => {
  const p = providersFrom({ ...baseEnv, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' })
  expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['drive', 'gmail']))
  expect(new URL(p.drive.authUrl('S', 'https://r/callback', 'C')).searchParams.get('scope')).toContain('drive.readonly')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/connect-providers.test.ts tests/connect-relay.test.ts tests/connect-relay-worker.test.ts`
Expected: the new tests FAIL (`DRIVE_SCOPES` undefined, page text mismatch, no `drive` key).

- [ ] **Step 3: Implement**

- `providers.ts`: add `DRIVE_SCOPES`, `ProviderCopy`, the `opts` parameter, and export `DRIVE_COPY`:
  - heading `Connect your Google Drive`
  - grant `This lets <strong>{who}</strong> see and download the files in your Google Drive. It cannot change them.`
  - risk `Continuing would give them your files.`
  - done `Connected to {who}. Go back to Havn. Your Drive files will appear in the files panel.`
- `relay.ts`: `confirm` and the done page (line ~349) read `p.copy`, falling back to today's exact strings when absent.
- `worker.ts` `providersFrom`: `out.drive = googleProvider(app, undefined, undefined, { scopes: DRIVE_SCOPES, copy: DRIVE_COPY })`.
- `README.md` of the relay: one paragraph, "Drive is a second Google provider; add the `drive.readonly` scope to the consent screen before deploying".

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: all PASS, including every pre-existing test in the three files.

- [ ] **Step 5: Commit**

`git add src/connect/providers.ts src/connect/relay.ts deploy/connect-relay/worker.ts deploy/connect-relay/README.md tests/connect-providers.test.ts tests/connect-relay.test.ts tests/connect-relay-worker.test.ts && git commit -m "Relay: drive provider with its own scopes and confirmation copy (#284)"`

---

### Task 2: Drive token store and keeper

**Files:**
- Create: `src/connect/relay-entries.ts`, `src/connect/drive-token.ts`
- Modify: `src/connect/gmail-token.ts` (use the shared helpers; exported names and behaviour unchanged)
- Test: `tests/connect-drive-token.test.ts` (new); `tests/connect-gmail-token.test.ts` must pass unedited

**Interfaces:**
- Produces, in `relay-entries.ts` (the entry read/write/renew logic moved out of `gmail-token.ts`, parameterised):
  - `export interface RelayEntry { account: string; accessToken: string; refreshToken: string; expiresAt: number; revoked?: boolean }`
  - `readEntries(vault, name: string): Map<string, RelayEntry>`; `saveEntry(vault, name, e)`; `dropEntry(vault, name, account, refreshToken?): boolean`
  - `renewEntries(o: { vault; name: string; provider: string; client: RelayClient; now: () => number }): Promise<{ result: KeeperResult; withdrawn: string[] }>` (the body of today's `run`/`renew` without publishing)
- Produces, in `drive-token.ts`:
  - `export const DRIVE_ENTRY = 'CONNECT_DRIVE'`
  - `readDriveEntries(vault)`, `saveDriveEntry(vault, e)`, `dropDriveEntry(vault, account, refreshToken?)`
  - `class DriveTokenKeeper { constructor(o: { relayUrl; boxId; handoffKey; vault; fetchImpl?; now?; onRevoked? }); tick(): Promise<KeeperResult>; accounts(): { account: string; state: 'ok' | 'reconnect' }[]; token(account: string): Promise<string | null> }`
    - `token` renews first if less than 5 minutes are left, returns null for unknown, revoked or unrenewable.
    - Registers tokens with `registerRotatingSecret('drive:<account>:access' | ':refresh', ...)`.

- [ ] **Step 1: Write the failing tests** (`tests/connect-drive-token.test.ts`, fake vault as a `Map`, fake relay `fetch`)

```ts
it('renews through the relay as provider "drive"', async () => {
  // entry expiring in 1 minute; fake /refresh returns { accessToken: 'NEW', expiresAt: t + 3_600_000 }
  expect(await keeper.tick()).toBe('renewed')
  expect(JSON.parse(lastRefreshBody).provider).toBe('drive')
  expect(readDriveEntries(vault).get('m@x.com')!.accessToken).toBe('NEW')
})
it('never puts a Drive token in the environment', async () => {
  const env: Record<string, string | undefined> = {}
  await keeper.tick()
  expect(JSON.stringify(process.env)).not.toContain('NEW')
  expect(process.env.GOG_ACCESS_TOKEN).toBeUndefined()
  expect(process.env.GOG_RELAY_TOKENS ?? '').not.toContain('m@x.com')
})
it('marks a withdrawn grant, tells the owner once, and reports reconnect', async () => {
  // fake /refresh -> 401 { error: 'invalid_grant' }
  await keeper.tick(); await keeper.tick()
  expect(onRevoked).toHaveBeenCalledTimes(1)
  expect(keeper.accounts()).toEqual([{ account: 'm@x.com', state: 'reconnect' }])
  expect(await keeper.token('m@x.com')).toBeNull()
})
it('token() renews an almost-expired token before returning it', async () => { /* 2 min left -> returns 'NEW' */ })
it('token() is null for an account that is not connected', async () => { expect(await keeper.token('nobody@x.com')).toBeNull() })
it('keeps Drive and Gmail entries apart', () => {
  saveDriveEntry(vault, entry); expect(readGmailEntries(vault).size).toBe(0); expect(vault.has('CONNECT_GMAIL')).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/connect-drive-token.test.ts` Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `relay-entries.ts`, then `drive-token.ts`, then switch `gmail-token.ts` to the shared helpers (its `publish` and env handling stay where they are).

- [ ] **Step 4: Run to verify**

Run: `npx vitest run tests/connect-drive-token.test.ts tests/connect-gmail-token.test.ts tests/connect-box.test.ts tests/connect-wiring.test.ts`
Expected: all PASS; `git diff --stat tests/connect-gmail-token.test.ts` is empty.

- [ ] **Step 5: Commit** the three source files and the new test: `"Connect: Drive token store and keeper, kept out of the environment (#284)"`

---

### Task 3: `/connect drive` on the box

**Files:**
- Modify: `src/connect/box.ts`, `src/connect/instance.ts`, `src/connect/wiring.ts`
- Test: `tests/connect-box.test.ts`, `tests/connect-wiring.test.ts`

**Interfaces:**
- Consumes: Task 2's `readDriveEntries`, `saveDriveEntry`, `dropDriveEntry`, `DriveTokenKeeper`.
- Produces:
  - `ConnectFlow.startLink(chatId: string, provider: 'gmail' | 'outlook' | 'drive'): string` (the one-time relay URL; `handleCommand` uses it).
  - `getDriveKeeper(): DriveTokenKeeper | null` and `setDriveRevokedHandler(fn)` in `instance.ts`; `onChange('drive')` ticks it.
  - `wiring.ts` starts the Drive keeper on the same `KEEPER_TICK_MS` timer pattern.

- [ ] **Step 1: Write the failing tests** (in `tests/connect-box.test.ts`, with its existing flow fixture)

```ts
it('/connect drive gives a one-time link for provider drive', () => {
  expect(new URL(linkIn(flow.handleCommand('c1', '/connect drive').reply)).searchParams.get('provider')).toBe('drive')
})
it('a drive hand-off is stored apart from Gmail and leaves IMAP alone', async () => {
  // gmail + imap entries for m@x.com exist; accept a signed drive hand-off for m@x.com
  expect(r).toMatchObject({ status: 200, message: 'Connected m@x.com. Google Drive is now in the files panel, read only.' })
  expect(readDriveEntries(vault).has('m@x.com')).toBe(true)
  expect(readGmailEntries(vault).get('m@x.com')!.accessToken).toBe('GMAIL-AT')
  expect(vault.get(imapAccountName('m@x.com'))).toBeDefined()
})
it('/connect list shows drive accounts', () => { expect(flow.handleCommand('c1', '/connect list').reply).toContain('drive: m@x.com') })
it('removing Drive is local only and never calls the relay', async () => {
  const out = await flow.handleCommandAsync('c1', '/connect remove drive m@x.com')
  expect(revoke).not.toHaveBeenCalled()
  expect(readDriveEntries(vault).size).toBe(0)
  expect(out.reply).toBe('Removed Google Drive for m@x.com from this box. To withdraw the permission at Google, remove Havn under myaccount.google.com/connections; that also disconnects its Gmail.')
})
it('removing Gmail also drops that address\'s Drive and says so', async () => {
  const out = await flow.handleCommandAsync('c1', '/connect remove gmail m@x.com')
  expect(readDriveEntries(vault).has('m@x.com')).toBe(false)
  expect(out.reply).toContain('This also disconnected Google Drive for that account.')
})
it('removing Gmail for an address without Drive says nothing about Drive', async () => { /* reply not.toContain('Google Drive') */ })
```
In `tests/connect-wiring.test.ts`: the revoked handler posts exactly
`Google Drive access for m@x.com was withdrawn at Google. Open the files panel and connect again.` to the primary chat.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/connect-box.test.ts tests/connect-wiring.test.ts`

- [ ] **Step 3: Implement.** `PROVIDERS` gains `'drive'`; usage text gains `/connect drive - see your Google Drive in the files panel (read only)` and `/connect remove drive <account> - forget Drive on this box`. The "which account?" prompts for `remove drive` mirror Gmail's.

- [ ] **Step 4: Run to verify they pass** (same command; all pre-existing tests in both files too).

- [ ] **Step 5: Commit:** `"Connect: /connect drive, local-only removal, Gmail removal takes Drive with it (#284)"`

---

### Task 4: Reading Drive through `gog`

**Files:**
- Create: `src/web/drive.ts`
- Modify: `src/infra/gog-bin.ts` (add `realGogBin(): string | null`, set alongside `setGogShim`), `src/connect/instance.ts` (record the real path)
- Test: `tests/web-drive.test.ts` (new), `tests/gog-bin.test.ts`

**Interfaces:**
- Consumes: `getDriveKeeper()`, `connectSettings()`, `realGogBin()`, `cachedCheck`.
- Produces (all in `drive.ts`; `deps` is injectable for tests: `{ run(args: string[], env: Record<string,string>, timeoutMs: number): Promise<{ code: number; stdout: string }>; keeper; relayConfigured: boolean; gogAccounts(): Promise<{ account: string; services: string[] }[]>; tmpDir: string; now() }`):
  - `type DriveError = 'not_connected' | 'reconnect' | 'not_found' | 'too_large' | 'unavailable'`; `class DriveFailure extends Error { code: DriveError }`
  - `interface DriveEntry { id: string; name: string; isDir: boolean; mimeType: string; size?: number; modified?: string }`
  - `driveAccounts(deps?): Promise<{ account: string; state: 'ok' | 'reconnect' }[]>`
  - `driveConnectMode(deps?): 'relay' | 'gog' | null`
  - `listFolder(account: string, folderId: string, pageToken?: string, deps?): Promise<{ entries: DriveEntry[]; nextPage: string | null }>`
  - `getFile(account, fileId, deps?): Promise<DriveEntry>`
  - `fetchFile(account, fileId, deps?): Promise<{ path: string; name: string; mimeType: string; cleanup(): void }>`
  - `export const MAX_DRIVE_BYTES = 25 * 1024 * 1024`, `DRIVE_ID = /^[A-Za-z0-9_-]{1,128}$/`, `PAGE_SIZE = 100`
  - `export const GOOGLE_EXPORT_PDF = new Set(['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation'])`; folder mime `application/vnd.google-apps.folder`. Any other `application/vnd.google-apps.*` type (Forms, Sites, shortcuts) has no preview: the route gives it kind `other` and the page never fetches it; `fetchFile` on one throws `DriveFailure('not_found')`.

- [ ] **Step 1: Write the failing tests** (`tests/web-drive.test.ts`, fake `run` recording `args` and `env`)

```ts
it('lists a folder read only, My Drive only, with the token in the environment not the arguments', async () => {
  await listFolder('m@x.com', 'root', undefined, deps)
  expect(call.args).toEqual(expect.arrayContaining(['drive', 'ls', '--json', '--readonly', '--parent', 'root', '--max', '100', '--no-all-drives']))
  expect(call.args).toEqual(expect.arrayContaining(['--enable-commands-exact', 'drive.ls']))
  expect(call.args).not.toContain('--results-only')
  expect(call.args.join(' ')).not.toContain('TOKEN-1'); expect(call.env.GOG_ACCESS_TOKEN).toBe('TOKEN-1')
})
it('a gog-signed account is named with --account and gets no token', async () => { /* relayConfigured:false -> args contain ['--account','m@x.com'], env has no GOG_ACCESS_TOKEN */ })
it('maps entries, folders first, and passes the next page token through', async () => {
  // stdout: files [doc, folder], nextPageToken 'P2'
  expect(r.entries.map((e) => e.name)).toEqual(['Folder', 'Doc']); expect(r.entries[0].isDir).toBe(true); expect(r.nextPage).toBe('P2')
})
it('an empty folder is an empty list with no next page', async () => { expect(r).toEqual({ entries: [], nextPage: null }) })
it('leaves trashed files out', async () => { /* a row with trashed:true is dropped, or the query excludes it: assert it is absent */ })
it.each(['../x', 'a b', '', 'x'.repeat(129), 'id;rm'])('refuses folder id %j before gog runs', async (id) => {
  await expect(listFolder('m@x.com', id, undefined, deps)).rejects.toMatchObject({ code: 'not_found' }); expect(run).not.toHaveBeenCalled()
})
it('refuses an account that has no Drive connection', async () => { /* rejects code 'not_connected', run not called */ })
it('a revoked or missing token answers reconnect', async () => { /* keeper.token -> null with state reconnect => code 'reconnect' */ })
it('a timeout, a missing gog and a non-zero exit all answer unavailable', async () => { /* three cases */ })
it('exports a Google Doc as a PDF with a safe name', async () => {
  // getFile -> { name: 'Q4 "plan"/draft', mimeType: 'application/vnd.google-apps.document' }
  const f = await fetchFile('m@x.com', 'abc', deps)
  expect(call.args).toEqual(expect.arrayContaining(['drive', 'download', 'abc', '--format', 'pdf', '--out', f.path]))
  expect(f.name).toBe('Q4 _plan__draft.pdf'); expect(f.mimeType).toBe('application/pdf'); expect(f.path.startsWith(deps.tmpDir)).toBe(true)
})
it('refuses a file over 25 MB before downloading', async () => { /* getFile size 25*1024*1024+1 -> code 'too_large', one run call (get) only */ })
it('cleanup removes the temp file, and a failed download leaves none behind', async () => { /* both branches */ })
it('sweeps temp files older than ten minutes on each fetch', async () => { /* old file gone, 5-minute-old file kept */ })
it('runs at most two gog calls at once', async () => { /* start 3 lists with a held run; expect 2 in flight until one resolves */ })
it('on a relay box only relay-connected accounts are listed, gog sign-ins are ignored', async () => {
  expect(await driveAccounts({ ...deps, relayConfigured: true, gogAccounts: async () => [{ account: 'other@x.com', services: ['drive'] }] })).toEqual([{ account: 'm@x.com', state: 'ok' }])
})
it('without the relay, gog accounts whose services include drive are listed', async () => { /* gmail-only account left out */ })
```
In `tests/gog-bin.test.ts`: `realGogBin()` is null before the shim is set up and the real path after, never the shim path.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/web-drive.test.ts tests/gog-bin.test.ts`

- [ ] **Step 3: Implement.** Notes the tests do not settle:
  - Read the real field names once from `gog drive ls --json --help`/schema and a real call during the live check; map defensively (`id`, `name`, `mimeType`, `size` as string or number, `modifiedTime`).
  - Trashed and ordering go through `--query "trashed = false"` and an order flag if `gog drive ls --help` offers one; otherwise sort the page in code.
  - Verify `--readonly` lets a gog-signed account refresh its own token (run `gog drive ls --readonly` against a real gog account more than an hour after sign-in, at the live check). If it does not, drop `--readonly` on the gog path only and note it in the spec.
  - Default `run` uses `execFile` with `timeout: 30_000`, `maxBuffer` 8 MB, env = a copy of `process.env` without `GOG_ACCESS_TOKEN`/`GOG_RELAY_TOKENS`, plus the Drive token when there is one.
  - Log lines: `logger.info({ event: 'drive list', entries: n, ok: true })` shape only.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit:** `"Web: read-only Drive access through gog (#284)"`

---

### Task 5: Shared preview "kind"

**Files:**
- Create: `src/web/file-kind.ts`, `public/app/filekind.js`
- Modify: `src/web/file-routes.ts`, `public/app/app.js` (the `preview` function), `public/app/index.html` (script tag if modules are listed there)
- Test: `tests/web-file-kind.test.ts` (new); `tests/web-files.test.ts` and `tests/web-files-scope.test.ts` pass unedited

**Interfaces:**
- Produces, server: `type FileKind = 'image' | 'pdf' | 'text' | 'markdown' | 'other'`; `kindFromName(name: string): { kind: FileKind; mime: string }`; `kindFromMime(mime: string): { kind: FileKind; mime: string }`; `rawHeaders(kind: FileKind, mime: string, name: string, size: number): Record<string, string | number>` (today's header block, moved); `dispositionName(name: string): string` (moved, exported).
- Produces, page (`filekind.js`, plain ES module): `kindFromName(name)`, `kindFromMime(mime)` returning the same kind strings; `preview(entry)` in `app.js` takes `{ name, url, kind, openUrl? }`.
- Mime table for `kindFromMime`: `image/png|jpeg|gif|webp|svg+xml` -> image; `application/pdf` and the three `GOOGLE_EXPORT_PDF` types -> pdf; `text/markdown` -> markdown; `text/plain|csv|html`, `application/json` -> text; everything else -> other.

- [ ] **Step 1: Write the failing tests** (`tests/web-file-kind.test.ts`)

```ts
it.each([['a.PNG', 'image'], ['a.pdf', 'pdf'], ['a.md', 'markdown'], ['a.csv', 'text'], ['a.docx', 'other'], ['noext', 'other']])('kindFromName(%s) is %s', (n, k) => expect(kindFromName(n).kind).toBe(k))
it.each([['image/jpeg', 'image'], ['application/vnd.google-apps.document', 'pdf'], ['application/vnd.google-apps.form', 'other'], ['text/markdown', 'markdown'], ['application/zip', 'other']])('kindFromMime(%s) is %s', (m, k) => expect(kindFromMime(m).kind).toBe(k))
it('a PDF may be framed by our own page only', () => {
  const h = rawHeaders('pdf', 'application/pdf', 'a.pdf', 10)
  expect(h['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'self'"); expect(h['X-Frame-Options']).toBe('SAMEORIGIN')
})
it('unknown kinds are attachments and every answer is nosniff', () => { /* Content-Disposition starts 'attachment', X-Content-Type-Options 'nosniff' */ })
it('text over 1 MB is an attachment', () => { /* rawHeaders('text', 'text/plain', 'a.txt', 1024*1024+1) */ })
it('the page helper agrees with the server for every row above', async () => { /* import ../public/app/filekind.js and compare */ })
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/web-file-kind.test.ts`

- [ ] **Step 3: Implement** by moving, not rewriting: the local route calls `kindFromName` then `rawHeaders`; the page's `preview` derives `kind` from the name for local entries.

- [ ] **Step 4: Run to verify.** `npx vitest run tests/web-file-kind.test.ts tests/web-files.test.ts tests/web-files-scope.test.ts tests/web-page-static.test.ts tests/web-files-panel-resize.test.ts` Expected: all PASS, no edits to the pre-existing four.

- [ ] **Step 5: Commit:** `"Web: one preview kind for local and remote files (#284)"`

---

### Task 6: Source routes and the Connections entry

**Files:**
- Create: `src/web/source-routes.ts`
- Modify: `src/web/index.ts` (import the new routes), `src/web/connections.ts`
- Test: `tests/web-source-routes.test.ts` (new, same server harness as `tests/web-files-scope.test.ts`: main chat 4242, second chat 777), `tests/web-connections.test.ts`, `tests/web-route-order.test.ts` if it lists routes

**Interfaces:**
- Consumes: Task 3 `ConnectFlow.startLink`; Task 4 `driveAccounts`, `driveConnectMode`, `listFolder`, `getFile`, `fetchFile`, `DriveFailure`; Task 5 `kindFromMime`, `rawHeaders`.
- Produces (JSON shapes the page relies on):
  - `GET /api/web/sources` -> `{ sources: Source[]; canConnectDrive: boolean; connect: 'relay' | 'gog' | null }`, `Source = { id: 'local'; name: 'Havn files' } | { id: 'drive:<account>'; name: 'Google Drive'; account: string; state: 'ok' | 'reconnect' }`
  - `GET /api/web/sources/drive/list?account=&folder=&page=` -> `{ entries: (DriveEntry & { kind: FileKind })[]; nextPage: string | null }`; `folder` defaults to `root`
  - `GET /api/web/sources/drive/raw?account=&id=` -> the bytes
  - `POST /api/web/sources/drive/connect` -> `{ url: string }` (relay) or `{ command: string }` (gog)
  - Errors: `DriveFailure` codes map to status `not_connected` 409, `reconnect` 409, `not_found` 404, `too_large` 413, `unavailable` 503, body `{ error: <code> }`.
  - `setDriveDepsForTests(deps | null)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('needs a session', async () => { expect((await get('/api/web/sources', null)).status).toBe(401) })
it('a second chat sees no Drive at all', async () => {
  for (const p of ['/api/web/sources/drive/list?account=m@x.com', '/api/web/sources/drive/raw?account=m@x.com&id=abc']) expect((await get(p, chat777)).status).toBe(404)
  expect((await post('/api/web/sources/drive/connect', chat777)).status).toBe(404)
  expect((await (await get('/api/web/sources', chat777)).json())).toEqual({ sources: [{ id: 'local', name: 'Havn files' }], canConnectDrive: false, connect: null })
})
it('the main chat sees its Drive accounts and their state', async () => { /* [{local}, {id:'drive:m@x.com', name:'Google Drive', account:'m@x.com', state:'ok'}], canConnectDrive true, connect 'relay' */ })
it('lists a folder with a kind on every entry', async () => { /* entries[0].kind === 'pdf' for a Google Doc; nextPage passed through */ })
it.each([['reconnect', 409], ['not_connected', 409], ['not_found', 404], ['too_large', 413], ['unavailable', 503]])('a %s failure answers %i with the code', async (code, status) => { /* body { error: code } */ })
it('serves a Google Doc as an inline PDF framed by our page only, then deletes the temp file', async () => {
  expect(res.headers.get('content-type')).toBe('application/pdf'); expect(res.headers.get('content-disposition')).toContain('inline')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff'); expect(existsSync(tmpPath)).toBe(false)
})
it('deletes the temp file when the browser goes away mid-download', async () => { /* abort the request; cleanup called */ })
it('connect on a relay box returns a one-time link for provider drive', async () => { /* new URL(body.url).searchParams.get('provider') === 'drive' */ })
it('connect on a gog box returns the command to run', async () => { /* body.command contains '--services gmail,calendar,drive --drive-scope readonly' */ })
it('connect needs the JSON content type', async () => { /* 415 or the harness's existing code for a form post */ })
it('logs counts, never ids, names or accounts', async () => { /* spy logger.info: JSON of all calls contains none of 'abc', 'Doc', 'm@x.com' */ })
```
In `tests/web-connections.test.ts`: with one Drive account the list has `{ id: 'drive', name: 'Google Drive', status: 'connected', detail: 'm@x.com' }`; with a revoked one, `status: 'attention'`, `next: 'Open the files panel and connect again.'`; with none, no `drive` row.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/web-source-routes.test.ts tests/web-connections.test.ts`

- [ ] **Step 3: Implement.** The registry is `const SOURCES = [{ prefix: 'drive', list, raw }]`. `raw` streams the temp file and calls `cleanup()` on `finish`, `close` and `error`. The gog command string is exactly `gog auth add <your Gmail address> --services gmail,calendar,drive --drive-scope readonly --gmail-scope send --extra-scopes https://www.googleapis.com/auth/gmail.modify`.

- [ ] **Step 4: Run to verify they pass**, plus `npx vitest run tests/web-http.test.ts tests/web-route-order.test.ts`.

- [ ] **Step 5: Commit:** `"Web: source routes for the files panel, main chat only (#284)"`

---

### Task 7: The page

**Files:**
- Create: `public/app/sources.js`
- Modify: `public/app/app.js`, `public/app/app.css`, `public/app/index.html`
- Test: `tests/web-sources-page.test.ts` (new, same style as `tests/web-files-panel-resize.test.ts`: import the ES module, plus string checks on `index.html`/`app.js`)

**Interfaces:**
- Consumes: Task 6 JSON shapes; Task 5 `filekind.js`.
- Produces, in `sources.js` (pure, no DOM):
  - `STORAGE_KEY = 'havn.files.source'`
  - `pickerOptions(resp): { id: string; label: string }[]`: "Havn files"; then one per Drive source, label `Google Drive` when there is one account, `Google Drive (<account>)` when several; when there are none and `resp.canConnectDrive`, a single `{ id: 'drive:', label: 'Google Drive' }`.
  - `showPicker(resp): boolean` (more than the local source, or `canConnectDrive`)
  - `resolveSource(saved: string | null, resp): string` (saved id if still offered, else `'local'`)
  - `viewFor(id: string, resp): 'tree' | 'connect' | 'reconnect'`
  - `driveListUrl(account, folder, page)`, `driveRawUrl(account, id)`, `driveOpenUrl(id)` = `https://drive.google.com/open?id=<id>`
  - `errorText(code): string`: `unavailable` -> "Google Drive is not available right now. Try again in a minute."; `too_large` -> "This file is too large to preview here. Open it in Google Drive."; `not_found` -> "This file is no longer in Google Drive."; `reconnect`/`not_connected` -> "Google Drive needs to be connected again."
- Page behaviour (in `app.js`): a `<select id="source-picker">` above `#tree`, hidden unless `showPicker`; Connect view copy "See your Google Drive files here, read only. Havn asks Google for permission to view them." with button "Connect Google Drive"; on a relay box the button opens the link in a new tab (`rel="noopener"`) and polls `/api/web/sources` every 5 s for up to 10 minutes; on a gog box it shows the command in a `<pre>`. Drive rows carry `data-id`; a folder with `nextPage` ends in a "Show more" row. Preview shows "Open in Google Drive" (new tab) for Drive entries. Refresh reloads the current source. A 409 from a list switches to the reconnect view.

- [ ] **Step 1: Write the failing tests**

```ts
it('no picker when there is only Havn files and Drive cannot be connected', () => expect(s.showPicker({ sources: [LOCAL], canConnectDrive: false, connect: null })).toBe(false))
it('offers Google Drive to connect when none is connected', () => expect(s.pickerOptions({ sources: [LOCAL], canConnectDrive: true, connect: 'relay' })).toEqual([{ id: 'local', label: 'Havn files' }, { id: 'drive:', label: 'Google Drive' }]))
it('leaves the account out with one Drive and names each with several', () => { /* 'Google Drive' vs 'Google Drive (a@x.com)', 'Google Drive (b@x.com)' */ })
it('a remembered source that is gone falls back to Havn files', () => expect(s.resolveSource('drive:gone@x.com', oneDrive)).toBe('local'))
it('garbage in storage falls back to Havn files', () => expect(s.resolveSource('}{', oneDrive)).toBe('local'))
it('an unconnected Drive shows the connect view and a revoked one the reconnect view', () => { /* viewFor('drive:', ...) 'connect'; state reconnect -> 'reconnect'; ok -> 'tree' */ })
it('builds encoded URLs', () => { /* account with + and @ encoded; driveOpenUrl('a_b-1') exact */ })
it('every error code has plain text with no em dash', () => { for (const c of CODES) { expect(s.errorText(c)).toBeTruthy(); expect(s.errorText(c)).not.toContain('—') } })
it('the page has the picker, the connect copy and a noopener link', () => {
  expect(html).toContain('id="source-picker"'); expect(js).toContain('See your Google Drive files here, read only.'); expect(js).toMatch(/noopener/)
})
it('Show more appears only with a next page', () => { /* s.needsMore({ nextPage: null }) false; { nextPage: 'P2' } true */ })
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/web-sources-page.test.ts`

- [ ] **Step 3: Implement** `sources.js` (add `needsMore`), then wire `app.js`, markup and styles. Keep the Drive tree inside the existing `treeItems`/`toggleDir` by passing a loader function instead of a path-based one; do not fork the tree code.

- [ ] **Step 4: Run to verify, then look at it.** `npx vitest run tests/web-sources-page.test.ts tests/web-page-static.test.ts tests/web-files-panel-resize.test.ts` all PASS. Then build and open the page in an isolated headless browser against a local server with `setDriveDepsForTests` fakes (never Marc's Chrome): screenshot the picker, the Connect view, a Drive tree with "Show more", a PDF preview, the reconnect view, at desktop width and at 390 px. Fix what looks wrong.

- [ ] **Step 5: Commit:** `"Web: source picker and Google Drive view in the files panel (#284)"`

---

### Task 8: Docs, version, full verification

**Files:**
- Modify: `VERSION` (next minor after the current value on `origin/main` at merge time; 1.88.0 as of writing), `CHANGELOG.md`, `docs/SETUP-GUIDE.md`, `docs/HOSTED-VPS.md`, `templates/skills/gmail/SKILL.md` (connect text only: one optional line with the Task 6 command; the skill gains no Drive instructions), `src/help-text.ts` if `/connect` is listed there, `docs/superpowers/specs/2026-11-23-drive-files-panel-design.md` (record what the live check found)

- [ ] **Step 1:** CHANGELOG entry, plain language: "**New: your Google Drive in the files panel.** ..." covering: the switcher, read only, connect once, only My Drive, files over 25 MB open in Google Drive, removing Gmail for an account also disconnects its Drive, self-installed boxes use the `gog` line in the setup guide.
- [ ] **Step 2:** `npx tsc --noEmit -p . && npm run build && npx vitest run` Expected: typecheck clean, build clean, whole suite PASS. Report any failure by name, including ones this branch did not cause.
- [ ] **Step 3:** `grep -rn "—" public/app/sources.js src/web/source-routes.ts src/web/drive.ts src/connect/drive-token.ts CHANGELOG.md | head` Expected: no em dash in new user-facing copy.
- [ ] **Step 4:** Commit, push, open the PR (title `Google Drive in the files panel, read only (v<version>, card #284)`). Do not merge.
- [ ] **Step 5 (needs Marc, stop and ask):** consent-screen scope added in the `havn-assistant` Google project; relay Worker redeploy; havn-test update. Then the live check from the spec, in order: connect through the relay, browse two levels, preview a Google Doc, an image and a PDF, refuse a file over 25 MB, remove Drive (Gmail keeps working), remove Gmail with Drive connected (both go, reply says so), a Drive download with egress enforced. Record results in the spec and on the card; move the card to Verify only after that.
