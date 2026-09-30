# Client Email & Calendar Onboarding

Runbook for connecting a client's Gmail or Outlook to their hosted Havn
instance, after `docs/HOSTED-VPS.md`'s finishing steps are done and the box
is running. Two roles throughout:

- 🧑‍💻 **YOU** — done over SSH on the client's VPS, or in your own browser.
- 👤 **CLIENT** — done in *their* browser, signed into *their* account.

**Rule that shapes this whole doc: you never see, type, or store the
client's Google or Microsoft password.** The only credential you ever handle
is the OAuth *client* (the app registration you own in your own Cloud
Console / Azure project) — never the account password. Every step that
touches the client's actual account is theirs to click through, in their own
browser.

---

## Part 1: Gmail + Google Calendar

Fully working today, tested end-to-end on a live hosted box (2026-08-23).

### Step A — 🧑‍💻 YOU: create a dedicated Google OAuth client (~10 min, before the client is involved)

One OAuth client per install — not shared across clients. Condensed version;
full click-by-click with every menu name is in
[SETUP-GUIDE.md § Connect Email](SETUP-GUIDE.md#step-2-connect-email).

1. [Google Cloud Console](https://console.cloud.google.com/) → new project,
   name it after the install (e.g. `havn-clientname`).
2. **APIs & Services → Library** → enable **Gmail API**.
3. Same page → enable **Google Calendar API** too. **Do not skip this** —
   it's the single most common miss. Gmail works fine without it; Calendar
   fails later with a 403 that looks unrelated.
4. **OAuth consent screen** → External → app name (e.g. `Havn`), your email
   as support/developer contact.
5. Add the client's Gmail address as a **test user**.
6. **Publish the app** (Overview/Audience page → Publish app). Must read **In
   production** before you move on — while it sits in Testing, Google
   silently kills every refresh token after 7 days and you're back here in a
   week.
7. **Credentials → Create credentials → OAuth client ID** → Application type
   **Desktop app** → **Download JSON** now (only offered once, at creation).

### Step B — 🧑‍💻 YOU: get the client onto the box, no client involvement yet

```bash
scp ~/Downloads/client_secret_*.json havn@<client-ip>:~/
ssh havn@<client-ip>
gog auth credentials set ~/client_secret_*.json
rm ~/client_secret_*.json               # don't leave the raw secret on disk
gog config set keyring_backend file     # headless Linux has no Secret Service
```

Add a keyring password to `.env` (encrypts the file-based token store; the
systemd service picks it up from `.env` automatically, but *you* need to
export it by hand in any interactive shell — `.env` isn't auto-sourced):

```bash
echo "GOG_KEYRING_PASSWORD=$(openssl rand -base64 32)" >> ~/havn/.env
export GOG_KEYRING_PASSWORD=$(grep GOG_KEYRING_PASSWORD ~/havn/.env | cut -d= -f2-)
gog auth doctor        # should report ok across the board
```

**Use `cut -d= -f2-` (with the trailing dash), never `-f2`.** A
`base64`-generated password routinely ends in `=` padding, and the line has
two `=` characters as a result (`KEY=value=`). Plain `-f2` takes only the
text between the *first two* `=`, silently dropping that trailing padding
character — so every command copy-pasting the password afterward exports a
value one character shorter than what's actually in `.env`. This is
insidious specifically because it looks like it's working: `gog auth doctor`
still reports `ok`, and any command run **interactively over SSH** (where
you're re-reading `.env` fresh each time with the same broken `cut`) stays
internally consistent and keeps succeeding. It only breaks once something
reads the *correctly-parsed* full value from `.env` directly — which is
exactly what the systemd service does via `EnvironmentFile=`. The two
diverge, and Gmail sends start failing with a keyring decrypt error
(`aes.KeyUnwrap(): integrity check failed`) that has nothing to do with
account setup and everything to do with a truncated `cut`. Cost real
debugging time on havn-test — check `-f2-` any time you see `cut -d=` in a
command against this file.

**Restart the service now.** `EnvironmentFile=-/home/havn/havn/.env` in the
systemd unit only loads at service start — if `havn` was already running
before you edited `.env`, it's stuck with the old environment and won't see
`GOG_KEYRING_PASSWORD` no matter what the file says. This bit us on
havn-test: the service ran for a day with a stale env, then failed to
auto-send a support-request email because it couldn't read its own token
(`0 readable OAuth tokens of 1 stored token account`). Any time you edit
`.env` on a hosted box, restart:

```bash
sudo systemctl restart havn
```

To confirm the running process actually picked it up (not just that the
restart succeeded):

```bash
PID=$(systemctl show havn --property=MainPID --value)
sudo cat /proc/$PID/environ | tr '\0' '\n' | grep GOG_KEYRING_PASSWORD
```

### Step C — 👤 CLIENT logs in (the only step that touches their account)

This is the one part best done live — on a call or screen share, not over
async chat, because the code exchanged at the end is single-use and expires
fast.

1. 🧑‍💻 On the box: `gog auth add client@gmail.com --services gmail,calendar --remote --step 1`
   — prints a Google OAuth URL.
2. 🧑‍💻 Send the client that URL right away (paste in the call/chat you're
   already on — don't let it sit).
3. 👤 **Client** opens it in **their own browser**, signs into **their own**
   Google account, and clicks through consent (and the one-time "Google
   hasn't verified this app" screen — expected, click **Advanced → Go to
   \<app name\> (unsafe)**). Warn them about this screen *before* they hit
   it so they don't bail out thinking something's wrong.
4. 👤 It redirects to a page that fails to load
   (`http://127.0.0.1:xxxxx/oauth2/callback?...`). That's expected — nothing
   is listening on that address. Tell them in advance.
5. 👤 **Client** copies the **entire address bar URL** from that broken page
   and sends it back to you immediately.
6. 🧑‍💻 On the box, exchange it — **single-quoted, exact, untouched**:
   ```bash
   gog auth add client@gmail.com --services gmail,calendar --remote --step 2 --auth-url 'PASTE_FULL_URL_HERE'
   ```
   The URL contains unescaped `&` characters. Pasted without quotes, bash
   reads each `&` as "run this in the background" and silently truncates the
   command before the auth code — you'll see bash print bogus background job
   lines and gog will fail with "no code found in URL." Don't try to fix a
   parse error by trimming `http://` or the host off the front — that just
   produces a different, worse error. If you fumble the paste twice, don't
   keep patching the same URL — the code is single-use and burns fast.
   Rerun step 1 for a fresh one and paste correctly the first time.

### Step D — 🧑‍💻 YOU: verify

```bash
gog gmail search "newer_than:1d" --account client@gmail.com
gog calendar events --account client@gmail.com
```

If calendar comes back `403 accessNotConfigured`, you skipped Step A.3 —
go enable the Calendar API on that Cloud project (browser, not the box), wait
a minute, retest. No re-auth needed, same token.

### Step E — done

Message the bot: "check my email," "what's on my calendar today." Restart
the service if it was already running: `sudo systemctl restart havn`.

---

## Part 2: Outlook / Microsoft 365

**Available since v1.28.0.** Mail (inbox, search, read, drafts, reply drafts,
send an approved draft) and calendar (today, a date range, create an event).

Easier to onboard than Gmail: there is no Azure app registration, no client
secret, and no Cloud project. The app registration ships with the product, so
the client signs in once and you are done. No step here needs anything
downloaded onto the box.

### Step A — 🧑‍💻 YOU: start the sign-in on the box

```bash
node dist/scripts/ms-auth.js start --account client@theircompany.com
```

It prints a Microsoft URL and a short code, then returns straight away. It
does not sit and wait, so this is safe to run over SSH.

### Step B — 👤 CLIENT: sign in

Send them the URL and the code exactly as printed. They open it in any
browser, including on a phone, enter the code, sign in with their own
Microsoft account, and approve.

Two things to warn them about in advance:

- The consent screen names the app and marks the **publisher as unverified**.
  That is expected for an app that is not in Microsoft's commercial
  marketplace. They can go ahead.
- If their organization blocks third-party apps, they will see **"needs admin
  approval"** instead. Their Microsoft 365 administrator has to approve the
  app once for the tenant. Retrying does not get past it, and neither does
  starting over. Stop and get the admin.

The code is good for **fifteen minutes**. After that, rerun Step A for a fresh
one.

### Step C — 🧑‍💻 YOU: collect it

```bash
node dist/scripts/ms-auth.js finish --account client@theircompany.com
```

If it reports it is still waiting, they have not finished in the browser yet.
Ask, then run it again. There is nothing to paste back from the client at any
point, which is the part that goes wrong most often on the Gmail side.

### Step D — 🧑‍💻 YOU: verify

```bash
node dist/scripts/ms-auth.js status
node dist/scripts/ms-mail.js inbox --count 3 --account client@theircompany.com
node dist/scripts/ms-calendar.js today --account client@theircompany.com
```

`status` also prints who Microsoft says each mailbox signed in as. If that is
a different address than the one you expected, the client signed in with
another account: use that address from then on rather than starting over.

### Step E — done

Message the bot: "check my email," "what's on my calendar today." Restart the
service if it was already running: `sudo systemctl restart havn`.

For a second mailbox, run the same three steps with the other address. Each is
stored separately. To disconnect one:
`node dist/scripts/ms-auth.js logout --account <address>`.

### Shipping under your own name

Optional, and not needed for a normal client onboarding. The consent screen
shows the app registration's publisher. To make it show yours instead, create
your own Azure app registration (public client, device code flow enabled, no
secret) and set `MS_CLIENT_ID` in `.env`. `MS_TENANT_ID` stays unset for
ordinary work accounts. See the notes in `.env.example`.

---

## Security recap

- You never type, see, or store the client's account password. Every login
  screen is theirs to click through.
- The only secret you handle is the Google OAuth *client* (your own app
  registration) — delete the downloaded JSON off the VPS once imported
  (`rm ~/client_secret_*.json`). Outlook has no equivalent: nothing is
  downloaded and there is no secret to clean up.
- Outlook sign-ins are stored in the encrypted vault, one entry per mailbox,
  not in `.env`. To revoke one, `ms-auth logout --account <address>` on the
  box; the client can also revoke it from their own Microsoft account.
- The auth code exchanged in Step C.6 is single-use and short-lived — treat
  it like a one-time password, not something to save or reuse.
- `GOG_KEYRING_PASSWORD` in `.env` is what encrypts the token store at rest
  on disk — keep `.env` off any snapshot or backup you hand to anyone else.
